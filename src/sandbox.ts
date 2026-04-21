import { spawn } from "node:child_process";

/**
 * Configuration describing where tools should execute.
 *
 * - `host`: run commands directly on the machine running the bot.
 * - `docker`: run commands inside a pre-existing Docker container.
 */
export type SandboxConfig = { type: "host" } | { type: "docker"; container: string };

/**
 * Thrown when a sandbox is misconfigured or unreachable.
 *
 * Library callers should catch this and decide how to surface it
 * (log + exit in a CLI, error reply in a bot, etc.).
 */
export class SandboxConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxConfigError";
	}
}

/**
 * Parse a `--sandbox=` CLI argument value into a {@link SandboxConfig}.
 *
 * Accepted forms:
 * - `host`
 * - `docker:<container-name>`
 *
 * Throws {@link SandboxConfigError} on invalid input.
 */
export function parseSandboxArg(value: string): SandboxConfig {
	if (value === "host") {
		return { type: "host" };
	}
	if (value.startsWith("docker:")) {
		const container = value.slice("docker:".length);
		if (!container) {
			throw new SandboxConfigError(
				"docker sandbox requires container name (e.g. docker:pi-sandbox)",
			);
		}
		return { type: "docker", container };
	}
	throw new SandboxConfigError(
		`Invalid sandbox type '${value}'. Use 'host' or 'docker:<container-name>'`,
	);
}

/**
 * Verify that the configured sandbox is usable.
 *
 * For `host` this is a no-op. For `docker`, checks that the Docker CLI is on
 * PATH and that the target container is running.
 *
 * Throws {@link SandboxConfigError} if any check fails.
 */
export async function validateSandbox(config: SandboxConfig): Promise<void> {
	if (config.type === "host") return;

	try {
		await execSimple("docker", ["--version"]);
	} catch {
		throw new SandboxConfigError("Docker is not installed or not in PATH");
	}

	let running: string;
	try {
		running = await execSimple("docker", ["inspect", "-f", "{{.State.Running}}", config.container]);
	} catch {
		throw new SandboxConfigError(
			`Container '${config.container}' does not exist. Create it with 'docker run -d --name ${config.container} -v <data-dir>:/workspace alpine:latest tail -f /dev/null'.`,
		);
	}

	if (running.trim() !== "true") {
		throw new SandboxConfigError(
			`Container '${config.container}' is not running. Start it with: docker start ${config.container}`,
		);
	}
}

/**
 * Create an {@link Executor} for the given sandbox configuration.
 *
 * Use {@link validateSandbox} beforehand if you want to fail fast on a missing
 * Docker CLI or stopped container.
 */
export function createExecutor(config: SandboxConfig): Executor {
	if (config.type === "host") {
		return new HostExecutor();
	}
	return new DockerExecutor(config.container);
}

/**
 * Executes bash commands on behalf of the tool implementations.
 *
 * Implementations can run on the host, in a Docker container, over SSH, etc.
 * Tools should only depend on this interface — never on a concrete executor.
 */
export interface Executor {
	/**
	 * Execute a bash command and return its stdout/stderr/exit code.
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Translate a host path into the path the executor sees.
	 *
	 * Host: returns the path as-is.
	 * Docker: typically maps host workspace → `/workspace`.
	 */
	getWorkspacePath(hostPath: string): string;
}

export interface ExecOptions {
	/** Timeout in seconds. No timeout if omitted or <= 0. */
	timeout?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Hard cap on stdout/stderr buffered per stream (10 MiB).
 * Individual tools apply their own truncation on top of this.
 */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Runs commands on the local machine via `sh -c` (or `cmd /c` on Windows).
 */
export class HostExecutor implements Executor {
	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];

			const child = spawn(shell, [...shellArgs, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			const timeoutHandle =
				options?.timeout && options.timeout > 0
					? setTimeout(() => {
							timedOut = true;
							if (child.pid) killProcessTree(child.pid);
						}, options.timeout * 1000)
					: undefined;

			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			if (options?.signal) {
				if (options.signal.aborted) {
					onAbort();
				} else {
					options.signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
				if (stdout.length > MAX_BUFFER_BYTES) {
					stdout = stdout.slice(0, MAX_BUFFER_BYTES);
				}
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
				if (stderr.length > MAX_BUFFER_BYTES) {
					stderr = stderr.slice(0, MAX_BUFFER_BYTES);
				}
			});

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}

				if (options?.signal?.aborted) {
					reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
					return;
				}

				if (timedOut) {
					reject(new Error(`${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim()));
					return;
				}

				resolve({ stdout, stderr, code: code ?? 0 });
			});

			child.on("error", (err) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				reject(err);
			});
		});
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

/**
 * Runs commands inside a pre-existing Docker container via `docker exec`.
 *
 * Delegates the actual child-process work to {@link HostExecutor}; this class
 * is just string wrapping around `docker exec <container> sh -c '<cmd>'`.
 *
 * The container is expected to have `/bin/sh` and a `/workspace` mount for the
 * bot's working directory. Alpine works out of the box; bash is not required.
 */
export class DockerExecutor implements Executor {
	private readonly host = new HostExecutor();

	constructor(private readonly container: string) {}

	exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		const dockerCmd = `docker exec ${this.container} sh -c ${shellEscape(command)}`;
		return this.host.exec(dockerCmd, options);
	}

	getWorkspacePath(_hostPath: string): string {
		return "/workspace";
	}
}

function execSimple(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("error", (err) => reject(err));
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr || `Exit code ${code}`));
		});
	});
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// ignore
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already dead
		}
	}
}
