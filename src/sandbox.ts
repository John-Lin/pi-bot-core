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

/** Executes shell commands on behalf of the workspace tools. */
export interface Executor {
	/**
	 * Execute a bash command and return its stdout/stderr/exit code.
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/** Store truncated output at a path readable by this executor. */
	saveOutput?(output: string, signal?: AbortSignal): Promise<string>;

	/** Translate the host workspace root to the executor's workspace root. */
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
