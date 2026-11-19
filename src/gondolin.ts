import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { ReadonlyProvider, RealFSProvider, ShadowProvider, VM } from "@earendil-works/gondolin";
import { SandboxConfigError, type ExecOptions, type ExecResult, type Executor } from "./sandbox.js";
import { ensureWorkspacePathIsSafe } from "./workspace-bootstrap.js";
import type { ChatPaths } from "./workspace.js";

export const GONDOLIN_IMAGE = "alpine-base:0.3.2";
export const GONDOLIN_WORKSPACE = "/workspace";
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const runFile = promisify(execFile);

const sandboxOptions = {
	vmm: "qemu",
	imagePath: GONDOLIN_IMAGE,
	netEnabled: false,
} as const;

/** Check native dependencies and cache the pinned image without booting a guest. */
export async function validateGondolinSandbox(): Promise<void> {
	if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
		throw new SandboxConfigError("Gondolin requires macOS or Linux on arm64 or x64");
	}
	for (const command of [process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64", "qemu-img"]) {
		try {
			await runFile(command, ["--version"], { timeout: 5_000 });
		} catch {
			throw new SandboxConfigError(`${command} is not usable; install QEMU and check the bot's PATH`);
		}
	}
	try {
		await (await VM.create({ autoStart: false, sandbox: sandboxOptions, vfs: null })).close();
	} catch (error) {
		throw new SandboxConfigError(`Cannot prepare Gondolin image ${GONDOLIN_IMAGE}: ${String(error)}`);
	}
}

/** One pool per bot process; a turn does not reserve capacity before its first tool call. */
export class GondolinSandbox {
	private active = 0;
	private readonly waiters = new Set<() => void>();

	constructor(private readonly maxConcurrent: number) {
		if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
			throw new Error("Gondolin needs a positive VM concurrency limit");
		}
	}

	turn(paths: ChatPaths): GondolinTurn {
		for (const path of [paths.chatDir, paths.scratchDir, paths.attachmentsDir, paths.skillsDir, join(paths.workspace, "skills")]) {
			ensureWorkspacePathIsSafe(path);
		}
		const memory = lstatSync(paths.memoryFile);
		if (!memory.isFile() || memory.nlink !== 1) throw new Error("Gondolin MEMORY.md must be an unlinked regular file");
		return new GondolinTurn(paths, (signal) => this.acquire(signal));
	}

	private async acquire(signal: AbortSignal): Promise<() => void> {
		while (this.active >= this.maxConcurrent) {
			signal.throwIfAborted();
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
		signal.throwIfAborted();
		this.active++;
		return () => {
			this.active--;
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
	private releaseSlot?: () => void;

	constructor(
		private readonly paths: ChatPaths,
		private readonly acquire: (signal: AbortSignal) => Promise<() => void>,
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
		const vm = this.vm;
		if (vm) await vm.close();
		await this.starting?.catch(() => {});
		// A close during asset resolution may not have had a VM to close yet.
		if (!vm && this.vm) await this.vm.close();
		this.releaseSlot?.();
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
		this.releaseSlot = await this.acquire(this.lifetime.signal);
		this.lifetime.signal.throwIfAborted();
		const sharedSkills = join(paths.workspace, "skills");
		this.vm = await VM.create({
			sandbox: sandboxOptions,
			startTimeoutMs: 15_000,
			vfs: {
				mounts: {
					[cwd]: new ShadowProvider(new RealFSProvider(paths.chatDir), {
						// MEMORY.md is the only projected file; preserve its identity for host reads.
						shouldShadow: ({ path, op }) => path === "/"
							? !["stat", "lstat", "realpath", "readdir", "access"].includes(op)
							: path !== "/MEMORY.md" || !["open", "stat", "lstat", "realpath", "readdir", "access"].includes(op),
					}),
					[`${cwd}/scratch`]: new RealFSProvider(paths.scratchDir),
					[`${cwd}/attachments`]: new ReadonlyProvider(new RealFSProvider(paths.attachmentsDir)),
					[`${cwd}/skills`]: new ReadonlyProvider(new RealFSProvider(paths.skillsDir)),
					[`${GONDOLIN_WORKSPACE}/skills`]: new ReadonlyProvider(new RealFSProvider(sharedSkills)),
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
