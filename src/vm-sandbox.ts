import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, createReadStream, lstatSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ERRNO, ReadonlyProvider, RealFSProvider, resolveImageSelector, SandboxVfsProvider, ShadowProvider, VM, type ResolvedImage, type VMOptions } from "@earendil-works/gondolin";
import { createSandboxWebSecretHooks, normalizeSandboxWebSecrets, type ActiveSandboxWebSecret, type SandboxWebSecret } from "./sandbox-web-secrets.js";
import { SandboxConfigError, type ExecOptions, type ExecResult, type Executor } from "./sandbox.js";
import { ensureWorkspacePathIsSafe } from "./workspace-bootstrap.js";
import { inspectWorkspaceEntry, openWorkspaceFile, UnsafeWorkspaceEntry } from "./workspace-files.js";
import type { ChatPaths } from "./workspace.js";

export type { SandboxWebSecret } from "./sandbox-web-secrets.js";

export const VM_SANDBOX_IMAGE = "alpine-base:0.3.2";
export const WORKSPACE_GUEST_ROOT = "/workspace";
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const VM_START_TIMEOUT_MS = 15_000;
const IMAGE_PREPARE_TIMEOUT_MS = 120_000;
const WORKSPACE_CLEANUP_FAILURE = "Workspace VM cleanup failed; the bot must be restarted before starting another turn.";
const runFile = promisify(execFile);
type FinishSlot = (failure?: Error) => void;

/** Keep the VM's paths independent of the caller's object and working directory. */
function snapshotTurnPaths(paths: ChatPaths): ChatPaths {
	return {
		...paths,
		workspace: resolve(paths.workspace),
		chatDir: resolve(paths.chatDir),
		memoryFile: resolve(paths.memoryFile),
		scratchDir: resolve(paths.scratchDir),
		attachmentsDir: resolve(paths.attachmentsDir),
		skillsDir: resolve(paths.skillsDir),
	};
}

function denyWorkspaceMutation(message: string): never {
	throw Object.assign(new Error(message), { code: "EACCES", errno: ERRNO.EACCES });
}

/** Keep guest mounts limited to ordinary directories and single-link files. */
class WorkspaceContentProvider extends RealFSProvider {
	constructor(private readonly mountDir: string) {
		super(mountDir);
	}

	checkEntry(path: string): void {
		inspectWorkspaceEntry(join(this.mountDir, posix.normalize(`/${path}`).slice(1)));
	}

	private readonly denyLink = () => denyWorkspaceMutation("Links are not allowed in workspace mounts");

	override symlinkSync = this.denyLink;
	override linkSync = this.denyLink;
	override readlinkSync = this.denyLink;
	override symlink = async () => this.denyLink();
	override link = this.symlink;
	override readlink = this.symlink;

	override realpath = async (path: string, options?: object): Promise<string> => {
		this.checkEntry(path);
		return super.realpath(path, options);
	};

	override realpathSync = (path: string, options?: object): string => {
		this.checkEntry(path);
		return super.realpathSync(path, options);
	};

	override access = async (path: string, mode?: number): Promise<void> => {
		this.checkEntry(path);
		return super.access(path, mode);
	};

	override accessSync = (path: string, mode?: number): void => {
		this.checkEntry(path);
		super.accessSync(path, mode);
	};
}

function workspaceMount({ mountDir, writable }: { mountDir: string; writable: boolean }) {
	const content = new WorkspaceContentProvider(mountDir);
	return new SandboxVfsProvider(writable ? content : new ReadonlyProvider(content), {
		before: ({ op, path, oldPath, newPath }) => {
			if ((path === "/" && (op === "rmdir" || op === "chmod")) ||
				(op === "rename" && (oldPath === "/" || newPath === "/"))) {
				denyWorkspaceMutation("Cannot modify the workspace mount root");
			}
			if (oldPath !== undefined) content.checkEntry(oldPath);
			if (newPath !== undefined) content.checkEntry(newPath);
			// Do not re-resolve paths during reads, writes, or release of open handles.
			if (path !== undefined && ["open", "stat", "lstat", "readdir", "mkdir", "rmdir", "unlink", "chmod", "truncate", "statfs"].includes(op)) {
				content.checkEntry(path);
			}
		},
	});
}

export type VMSandboxBackend = "qemu" | "krun";
const DEFAULT_BACKEND: VMSandboxBackend = "qemu";

export interface VMSandboxOptions {
	/** VM backend. Defaults to QEMU; krun must be selected explicitly. */
	backend?: VMSandboxBackend;
	/** Host credentials keyed by guest environment variable name. */
	secrets?: Readonly<Record<string, SandboxWebSecret>>;
	/** Allow guest writes to chat attachments, chat skills, and shared skills. */
	writableWorkspaceContent?: boolean;
}

function resolveBackend(backend: unknown): VMSandboxBackend {
	if (backend === undefined) return DEFAULT_BACKEND;
	if (backend === "qemu" || backend === "krun") return backend;
	throw new SandboxConfigError('Invalid VM sandbox backend; expected "qemu" or "krun"');
}

function vmResources(): Pick<VMOptions, "cpus" | "memory" | "rootfs"> {
	return { cpus: 2, memory: "2560M", rootfs: { size: "8G" } };
}

async function requireCommand(command: string): Promise<void> {
	try {
		await runFile(command, ["--version"], { timeout: 5_000 });
	} catch {
		throw new SandboxConfigError(`${command} is not usable; install it and check the bot's PATH`);
	}
}

/** Check the selected backend's startup requirements and cache the pinned image. */
export async function validateVMSandbox(options: Pick<VMSandboxOptions, "backend"> = {}): Promise<void> {
	const backend = resolveBackend(options.backend);
	if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
		throw new SandboxConfigError("The VM sandbox requires macOS or Linux on arm64 or x64");
	}
	if (backend === "krun" && !(process.platform === "darwin" && process.arch === "arm64") && !(process.platform === "linux" && process.arch === "x64")) {
		throw new SandboxConfigError("The packaged Gondolin krun runner requires Apple Silicon macOS or x64 Linux");
	}
	await requireCommand("qemu-img");
	let image: ResolvedImage;
	try {
		// Run the pull in its own process because the SDK's image fetch has no AbortSignal.
		const cli = fileURLToPath(new URL("./dist/bin/gondolin.js", import.meta.resolve("@earendil-works/gondolin/package.json")));
		await runFile(process.execPath, [cli, "image", "pull", VM_SANDBOX_IMAGE], {
			timeout: IMAGE_PREPARE_TIMEOUT_MS, killSignal: "SIGKILL",
		});
		// The SDK selects the emulator from the guest manifest, not the host architecture.
		image = resolveImageSelector(resolveImageSelector(VM_SANDBOX_IMAGE).assetDir);
	} catch (error) {
		throw new SandboxConfigError(`Cannot prepare VM sandbox image ${VM_SANDBOX_IMAGE} (startup budget: ${IMAGE_PREPARE_TIMEOUT_MS / 1000} seconds): ${String(error)}`);
	}
	if (backend === "qemu") {
		const arch = image.arch ?? (process.arch === "arm64" ? "aarch64" : "x86_64");
		await requireCommand(`qemu-system-${arch}`);
		return;
	}
	// Only a boot can confirm that the krun runner can use the host hypervisor.
	try {
		const vm = new VM({
			...vmResources(),
			sandbox: { vmm: backend, imagePath: image.assetDir, netEnabled: false },
			startTimeoutMs: VM_START_TIMEOUT_MS,
		});
		try {
			await vm.start();
		} finally {
			await vm.close();
		}
	} catch (error) {
		throw new SandboxConfigError(`Cannot start the VM sandbox with krun; check the installed runner and hardware virtualization (including /dev/kvm access on Linux): ${String(error)}`);
	}
}

/** One pool per bot process; a turn does not reserve capacity before its first tool call. */
export class VMSandbox {
	private active = 0;
	private failure?: Error;
	private readonly waiters = new Set<() => void>();
	private readonly secrets: readonly ActiveSandboxWebSecret[];
	private readonly backend: VMSandboxBackend;

	constructor(
		private readonly maxConcurrent: number,
		private readonly options: VMSandboxOptions = {},
	) {
		if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
			throw new Error("The VM sandbox needs a positive concurrency limit");
		}
		this.backend = resolveBackend(options.backend);
		if (Object.hasOwn(options, "credential")) throw new SandboxConfigError("Invalid VM sandbox option: use secrets instead of credential");
		this.secrets = normalizeSandboxWebSecrets(options.secrets);
	}

	turn(paths: ChatPaths): VMSandboxTurn {
		const snapshot = snapshotTurnPaths(paths);
		for (const path of [snapshot.chatDir, snapshot.scratchDir, snapshot.attachmentsDir, snapshot.skillsDir, join(snapshot.workspace, "skills")]) {
			ensureWorkspacePathIsSafe(path);
		}
		const memory = lstatSync(snapshot.memoryFile);
		if (!memory.isFile() || memory.nlink !== 1) throw new Error("VM sandbox MEMORY.md must be an unlinked regular file");
		return new VMSandboxTurn(snapshot, (signal) => this.acquire(signal), this.secrets, this.options.writableWorkspaceContent, this.backend);
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

export class VMSandboxTurn implements Executor {
	private readonly lifetime = new AbortController();
	private readonly paths: ChatPaths;
	private readonly cwd: string;
	private starting?: Promise<VM>;
	private vm?: VM;
	private closing?: Promise<void>;
	private finishSlot?: FinishSlot;

	constructor(
		paths: ChatPaths,
		private readonly acquire: (signal: AbortSignal) => Promise<FinishSlot>,
		private readonly secrets: readonly ActiveSandboxWebSecret[] = [],
		private readonly writableWorkspaceContent = false,
		private readonly backend: VMSandboxBackend = DEFAULT_BACKEND,
	) {
		this.paths = snapshotTurnPaths(paths);
		this.cwd = posix.join(WORKSPACE_GUEST_ROOT, basename(this.paths.chatDir));
	}

	getWorkspacePath(_hostPath: string): string {
		return WORKSPACE_GUEST_ROOT;
	}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const timeout = options?.timeout;
		const timer = timeout && Number.isFinite(timeout) && timeout > 0
			? AbortSignal.timeout(Math.min(2_147_483_647, Math.ceil(timeout * 1000)))
			: undefined;
		const signal = timer && options?.signal ? AbortSignal.any([timer, options.signal]) : timer ?? options?.signal;
		try {
			return await this.use(async (vm, signal) => {
				const proc = vm.exec(["/bin/sh", "-c", command], {
					cwd: this.cwd, signal, stdout: "pipe", stderr: "pipe",
				});
				const [result, stdout, stderr] = await Promise.all([
					proc, readBounded(proc.stdout), readBounded(proc.stderr),
				]);
				return { stdout: stdout.toString(), stderr: stderr.toString(), code: result.exitCode };
			}, signal);
		} catch (error) {
			if (error instanceof WorkspaceCleanupError) throw error;
			if (timer?.aborted && signal?.reason === timer.reason) throw new Error(`Command timed out after ${timeout} seconds`, { cause: error });
			if (signal?.aborted) throw new Error("Command aborted", { cause: error });
			throw error;
		}
	}

	async saveOutput(output: string, signal?: AbortSignal): Promise<string> {
		const path = `/tmp/pi-bot-bash-${randomBytes(8).toString("hex")}.log`;
		await this.use((vm, abort) => vm.fs.writeFile(path, output, { signal: abort }), signal);
		return path;
	}

	/** Export bytes from one of this turn's two attachment-capable mounts. */
	async readAttachment(path: string, signal?: AbortSignal): Promise<Buffer> {
		const mounts = [["scratch", this.paths.scratchDir], ["attachments", this.paths.attachmentsDir]] as const;
		const mount = mounts.find(([dir]) => path.startsWith(`${this.cwd}/${dir}/`));
		if (!mount || path !== posix.normalize(path) || path.endsWith("/") || path.includes("\0")) {
			throw new Error("attach: use a file in this chat's scratch or attachments directory");
		}
		const file = join(mount[1], path.slice(`${this.cwd}/${mount[0]}/`.length));
		return this.use(async (_vm, abort) => {
			let opened: ReturnType<typeof openWorkspaceFile>;
			try {
				opened = openWorkspaceFile(file);
			} catch (error) {
				if (error instanceof UnsafeWorkspaceEntry) throw error;
				throw new Error("attach: could not open the workspace file", { cause: error });
			}
			if (opened.size > BigInt(MAX_BUFFER_BYTES)) {
				closeSync(opened.fd);
				throw new Error("attach: maximum file size is 10 MiB");
			}
			// The stream owns the descriptor; a concurrent append cannot bypass the byte limit.
			return readBounded(createReadStream(file, { fd: opened.fd, start: 0, end: MAX_BUFFER_BYTES, signal: abort }));
		}, signal);
	}

	close(): Promise<void> {
		return this.closing ??= this.dispose();
	}

	private async dispose(): Promise<void> {
		this.lifetime.abort(new Error("The workspace sandbox turn is closed."));
		try {
			await this.vm?.close();
		} catch (cause) {
			this.finishSlot?.(new Error(WORKSPACE_CLEANUP_FAILURE, { cause }));
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
			if (abort.aborted || !vm || error instanceof WorkspaceOutputError) {
				try {
					await this.close();
				} catch (cleanupError) {
					throw new WorkspaceCleanupError([error, cleanupError], WORKSPACE_CLEANUP_FAILURE);
				}
			}
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
			imagePath = resolveImageSelector(VM_SANDBOX_IMAGE).assetDir;
		} catch (error) {
			throw new SandboxConfigError("The workspace VM image is unavailable. Ask the bot operator to run startup validation.", { cause: error });
		}
		this.finishSlot = await this.acquire(this.lifetime.signal);
		this.lifetime.signal.throwIfAborted();
		const sharedSkills = join(paths.workspace, "skills");
		const secretHooks = createSandboxWebSecretHooks(this.secrets);
		const contentMount = (path: string) => workspaceMount({ mountDir: path, writable: this.writableWorkspaceContent });
		this.vm = new VM({
			...vmResources(),
			sandbox: { vmm: this.backend, imagePath, netEnabled: true, ...(secretHooks ? { httpHooks: secretHooks.httpHooks } : {}), allowWebSockets: false },
			env: secretHooks?.env,
			startTimeoutMs: VM_START_TIMEOUT_MS,
			vfs: {
				mounts: {
					[cwd]: new ShadowProvider(workspaceMount({ mountDir: paths.chatDir, writable: true }), {
						// MEMORY.md is the only projected file; preserve its identity for host reads.
						shouldShadow: ({ path, op }) => path === "/"
							? !["stat", "lstat", "realpath", "readdir", "access"].includes(op)
							: path !== "/MEMORY.md" || !["open", "stat", "lstat", "realpath", "readdir", "access"].includes(op),
					}),
					[`${cwd}/scratch`]: workspaceMount({ mountDir: paths.scratchDir, writable: true }),
					[`${cwd}/attachments`]: contentMount(paths.attachmentsDir),
					[`${cwd}/skills`]: contentMount(paths.skillsDir),
					[`${WORKSPACE_GUEST_ROOT}/skills`]: contentMount(sharedSkills),
				},
			},
		});
		this.lifetime.signal.throwIfAborted();
		await this.vm.start();
		return this.vm;
	}
}

class WorkspaceOutputError extends Error {}
class WorkspaceCleanupError extends AggregateError {}

async function readBounded(stream: Readable | null): Promise<Buffer> {
	if (!stream) throw new WorkspaceOutputError("Workspace tool output stream is unavailable.");
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const value of stream) {
		const raw: unknown = value;
		if (typeof raw !== "string" && !(raw instanceof Uint8Array)) {
			throw new WorkspaceOutputError("Workspace tool output must be text or bytes.");
		}
		const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		length += chunk.length;
		if (length > MAX_BUFFER_BYTES) throw new WorkspaceOutputError("Workspace tool output exceeded 10 MiB.");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, length);
}
