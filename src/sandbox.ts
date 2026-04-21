import { spawn } from "node:child_process";

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
