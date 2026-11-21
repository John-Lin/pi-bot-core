import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ERRNO, ReadonlyProvider, RealFSProvider, resolveImageSelector, SandboxVfsProvider, ShadowProvider, VM, type ResolvedImage } from "@earendil-works/gondolin";
import { applyGondolinCredential, normalizeGondolinCredential, type ActiveGondolinCredential, type GondolinWebCredential } from "./gondolin-credential.js";
import { SandboxConfigError, type ExecOptions, type ExecResult, type Executor } from "./sandbox.js";
import { ensureWorkspacePathIsSafe } from "./workspace-bootstrap.js";
import type { ChatPaths } from "./workspace.js";

export const GONDOLIN_IMAGE = "alpine-base:0.3.2";
export const GONDOLIN_WORKSPACE = "/workspace";
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const VM_START_TIMEOUT_MS = 15_000;
const IMAGE_PREPARE_TIMEOUT_MS = 120_000;
const runFile = promisify(execFile);
type FinishSlot = (failure?: Error) => void;

function denyWorkspaceMutation(message: string): never {
	throw Object.assign(new Error(message), { code: "EACCES", errno: ERRNO.EACCES });
}

/** Prevent guests from planting links that host skill discovery or downloads could follow. */
class WorkspaceContentProvider extends RealFSProvider {
	private readonly denyLink = () => denyWorkspaceMutation("Links are not allowed in writable content mounts");

	override symlinkSync = this.denyLink;
	override linkSync = this.denyLink;
	override symlink = async () => this.denyLink();
	override link = this.symlink;
}

export type GondolinBackend = "qemu" | "krun";
const DEFAULT_BACKEND: GondolinBackend = "qemu";

export interface GondolinSandboxOptions {
	/** VM backend. Defaults to QEMU; krun must be selected explicitly. */
	backend?: GondolinBackend;
	/** Expose a placeholder for a host credential scoped to exact HTTPS POST URLs and one header. */
	credential?: GondolinWebCredential;
	/** Allow guest writes to chat attachments, chat skills, and shared skills. */
	writableWorkspaceContent?: boolean;
}

function resolveBackend(backend: unknown): GondolinBackend {
	if (backend === undefined) return DEFAULT_BACKEND;
	if (backend === "qemu" || backend === "krun") return backend;
	throw new SandboxConfigError('Invalid Gondolin backend; expected "qemu" or "krun"');
}

async function requireCommand(command: string): Promise<void> {
	try {
		await runFile(command, ["--version"], { timeout: 5_000 });
	} catch {
		throw new SandboxConfigError(`${command} is not usable; install it and check the bot's PATH`);
	}
}

/** Check the selected backend's startup requirements and cache the pinned image. */
export async function validateGondolinSandbox(options: Pick<GondolinSandboxOptions, "backend"> = {}): Promise<void> {
	const backend = resolveBackend(options.backend);
	if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
		throw new SandboxConfigError("Gondolin requires macOS or Linux on arm64 or x64");
	}
	if (backend === "krun" && !(process.platform === "darwin" && process.arch === "arm64") && !(process.platform === "linux" && process.arch === "x64")) {
		throw new SandboxConfigError("The packaged Gondolin krun runner requires Apple Silicon macOS or x64 Linux");
	}
	await requireCommand("qemu-img");
	let image: ResolvedImage;
	try {
		// Run the pull in its own process because the SDK's image fetch has no AbortSignal.
		const cli = fileURLToPath(new URL("./dist/bin/gondolin.js", import.meta.resolve("@earendil-works/gondolin/package.json")));
		await runFile(process.execPath, [cli, "image", "pull", GONDOLIN_IMAGE], {
			timeout: IMAGE_PREPARE_TIMEOUT_MS, killSignal: "SIGKILL",
		});
		// The SDK selects the emulator from the guest manifest, not the host architecture.
		image = resolveImageSelector(resolveImageSelector(GONDOLIN_IMAGE).assetDir);
	} catch (error) {
		throw new SandboxConfigError(`Cannot prepare Gondolin image ${GONDOLIN_IMAGE} (startup budget: ${IMAGE_PREPARE_TIMEOUT_MS / 1000} seconds): ${String(error)}`);
	}
	if (backend === "qemu") {
		const arch = image.arch ?? (process.arch === "arm64" ? "aarch64" : "x86_64");
		await requireCommand(`qemu-system-${arch}`);
		return;
	}
	// Only a boot can confirm that the krun runner can use the host hypervisor.
	try {
		const vm = new VM({
			sandbox: { vmm: backend, imagePath: image.assetDir, netEnabled: false },
			startTimeoutMs: VM_START_TIMEOUT_MS,
		});
		try {
			await vm.start();
		} finally {
			await vm.close();
		}
	} catch (error) {
		throw new SandboxConfigError(`Cannot start Gondolin with krun; check the installed runner and hardware virtualization (including /dev/kvm access on Linux): ${String(error)}`);
	}
}

/** One pool per bot process; a turn does not reserve capacity before its first tool call. */
export class GondolinSandbox {
	private active = 0;
	private failure?: Error;
	private readonly waiters = new Set<() => void>();
	private readonly credential?: ActiveGondolinCredential;
	private readonly backend: GondolinBackend;

	constructor(
		private readonly maxConcurrent: number,
		private readonly options: GondolinSandboxOptions = {},
	) {
		if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
			throw new Error("Gondolin needs a positive VM concurrency limit");
		}
		this.backend = resolveBackend(options.backend);
		this.credential = options.credential && normalizeGondolinCredential(options.credential);
	}

	turn(paths: ChatPaths): GondolinTurn {
		for (const path of [paths.chatDir, paths.scratchDir, paths.attachmentsDir, paths.skillsDir, join(paths.workspace, "skills")]) {
			ensureWorkspacePathIsSafe(path);
		}
		const memory = lstatSync(paths.memoryFile);
		if (!memory.isFile() || memory.nlink !== 1) throw new Error("Gondolin MEMORY.md must be an unlinked regular file");
		return new GondolinTurn(paths, (signal) => this.acquire(signal), this.credential, this.options.writableWorkspaceContent, this.backend);
	}

	private async acquire(signal: AbortSignal): Promise<FinishSlot> {
		while (true) {
			signal.throwIfAborted();
			if (this.failure) throw this.failure;
			if (this.active < this.maxConcurrent) break;
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					signal.removeEventListener("abort", onAbort);
					this.waiters.delete(wake);
				};
				const wake = () => { cleanup(); resolve(); };
				const onAbort = () => { cleanup(); reject(signal.reason); };
				this.waiters.add(wake);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		}
		this.active++;
		return (failure) => {
			// Never reuse capacity when the SDK could not confirm teardown.
			if (failure) this.failure ??= failure;
			else this.active--;
			for (const wake of this.waiters) wake();
		};
	}
}

export class GondolinTurn implements Executor {
	private readonly lifetime = new AbortController();
	private readonly cwd: string;
	private starting?: Promise<VM>;
	private vm?: VM;
	private closing?: Promise<void>;
	private finishSlot?: FinishSlot;

	constructor(
		private readonly paths: ChatPaths,
		private readonly acquire: (signal: AbortSignal) => Promise<FinishSlot>,
		private readonly credential?: ActiveGondolinCredential,
		private readonly writableWorkspaceContent = false,
		private readonly backend: GondolinBackend = DEFAULT_BACKEND,
	) {
		this.cwd = posix.join(GONDOLIN_WORKSPACE, basename(paths.chatDir));
	}

	getWorkspacePath(_hostPath: string): string {
		return GONDOLIN_WORKSPACE;
	}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const timeout = options?.timeout;
		const timer = timeout && Number.isFinite(timeout) && timeout > 0
			? AbortSignal.timeout(Math.min(2_147_483_647, Math.ceil(timeout * 1000)))
			: undefined;
		try {
			return await this.use(async (vm, signal) => {
				const proc = vm.exec(["/bin/sh", "-c", command], {
					cwd: this.cwd, signal, stdout: "pipe", stderr: "pipe",
				});
				const [result, stdout, stderr] = await Promise.all([
					proc, readBounded(proc.stdout!), readBounded(proc.stderr!),
				]);
				return { stdout: stdout.toString(), stderr: stderr.toString(), code: result.exitCode };
			}, timer && options?.signal ? AbortSignal.any([timer, options.signal]) : timer ?? options?.signal);
		} catch (error) {
			if (options?.signal?.aborted) throw new Error("Command aborted", { cause: error });
			if (timer?.aborted) throw new Error(`Command timed out after ${timeout} seconds`, { cause: error });
			throw error;
		}
	}

	async saveOutput(output: string, signal?: AbortSignal): Promise<string> {
		const path = `/tmp/pi-bot-bash-${randomBytes(8).toString("hex")}.log`;
		await this.use((vm, abort) => vm.fs.writeFile(path, output, { signal: abort }), signal);
		return path;
	}

	/** Export guest bytes, never a path the caller would open in the bot's filesystem. */
	async readAttachment(path: string, signal?: AbortSignal): Promise<Buffer> {
		const normalized = posix.normalize(path);
		if (path !== normalized || !["scratch", "attachments"].some((dir) => path.startsWith(`${this.cwd}/${dir}/`))) {
			throw new Error("attach: use a file in this chat's scratch or attachments directory");
		}
		return this.use(async (vm, abort) => {
			const stat = await vm.fs.stat(path, { signal: abort });
			if (!stat.isFile()) throw new Error("attach: expected a regular file");
			if (stat.size > MAX_BUFFER_BYTES) throw new Error("attach: maximum file size is 10 MiB");
			return readBounded(await vm.fs.readFileStream(path, { signal: abort }));
		}, signal);
	}

	close(): Promise<void> {
		return this.closing ??= this.dispose();
	}

	private async dispose(): Promise<void> {
		this.lifetime.abort(new Error("Gondolin turn is closed"));
		try {
			await this.vm?.close();
		} catch (cause) {
			this.finishSlot?.(new Error("Gondolin VM cleanup failed; restart the bot before starting another VM", { cause }));
			throw cause;
		}
		await this.starting?.catch(() => {});
		this.finishSlot?.();
	}

	private async use<T>(run: (vm: VM, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		this.lifetime.signal.throwIfAborted();
		signal?.throwIfAborted();
		const abort = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
		const onAbort = () => { void this.close().catch(() => {}); };
		signal?.addEventListener("abort", onAbort, { once: true });
		let vm: VM | undefined;
		try {
			vm = await (this.starting ??= this.start());
			abort.throwIfAborted();
			return await run(vm, abort);
		} catch (error) {
			// Stopping an SDK exec is not a guarantee that its guest process has stopped.
			if (abort.aborted || !vm || error instanceof OutputLimitError) await this.close();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async start(): Promise<VM> {
		const { paths, cwd } = this;
		// Image downloads belong to startup, never to an active turn or VM lease.
		let imagePath: string;
		try {
			imagePath = resolveImageSelector(GONDOLIN_IMAGE).assetDir;
		} catch (error) {
			throw new SandboxConfigError(`Gondolin image ${GONDOLIN_IMAGE} is not available locally; run startup validation: ${String(error)}`);
		}
		this.finishSlot = await this.acquire(this.lifetime.signal);
		this.lifetime.signal.throwIfAborted();
		const sharedSkills = join(paths.workspace, "skills");
		const credential = this.credential;
		const placeholder = credential && randomBytes(24).toString("hex");
		const httpHooks = credential && placeholder ? {
			onRequest: (request: Request) => applyGondolinCredential(request, credential, placeholder),
		} : undefined;
		const contentMount = (path: string) => this.writableWorkspaceContent
			? new SandboxVfsProvider(new WorkspaceContentProvider(path), {
				before: ({ op, path, oldPath, newPath }) => {
					// Both guest aliases must preserve the host-managed mount directory.
					if ((path === "/" && (op === "rmdir" || op === "chmod")) ||
						(op === "rename" && (oldPath === "/" || newPath === "/"))) {
						denyWorkspaceMutation("Cannot modify the workspace mount root");
					}
				},
			})
			: new ReadonlyProvider(new RealFSProvider(path));
		this.vm = new VM({
			sandbox: { vmm: this.backend, imagePath, netEnabled: true, httpHooks, allowWebSockets: false },
			env: credential && placeholder ? { [credential.env]: placeholder } : undefined,
			startTimeoutMs: VM_START_TIMEOUT_MS,
			vfs: {
				mounts: {
					[cwd]: new ShadowProvider(new RealFSProvider(paths.chatDir), {
						// MEMORY.md is the only projected file; preserve its identity for host reads.
						shouldShadow: ({ path, op }) => path === "/"
							? !["stat", "lstat", "realpath", "readdir", "access"].includes(op)
							: path !== "/MEMORY.md" || !["open", "stat", "lstat", "realpath", "readdir", "access"].includes(op),
					}),
					[`${cwd}/scratch`]: new RealFSProvider(paths.scratchDir),
					[`${cwd}/attachments`]: contentMount(paths.attachmentsDir),
					[`${cwd}/skills`]: contentMount(paths.skillsDir),
					[`${GONDOLIN_WORKSPACE}/skills`]: contentMount(sharedSkills),
				},
			},
		});
		this.lifetime.signal.throwIfAborted();
		await this.vm.start();
		return this.vm;
	}
}

class OutputLimitError extends Error {}

async function readBounded(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const value of stream) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		length += chunk.length;
		if (length > MAX_BUFFER_BYTES) throw new OutputLimitError("Gondolin stream exceeded 10 MiB");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, length);
}
