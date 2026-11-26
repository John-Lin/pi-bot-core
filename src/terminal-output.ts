import { Console } from "node:console";

// Losing a log reader must not turn otherwise successful bot work into a process error.
export const terminalOutput = new Console({
	stdout: process.stdout,
	stderr: process.stderr,
	ignoreErrors: true,
});
