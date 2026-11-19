import type { AgentTool } from "@earendil-works/pi-agent-core";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

const bashSchema = obj({
	label: str({ description: "Brief description of what this command does (shown to user)" }),
	command: str({ description: "Bash command to execute" }),
	timeout: opt(num({ description: "Timeout in seconds (optional, no default timeout)" })),
}, { open: true });

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export function createBashTool(executor: Executor): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, the tool tries to save full output to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { label: string; command: string; timeout?: number },
			signal?: AbortSignal,
		) => {
			let tempFilePath: string | undefined;

			const result = await executor.exec(command, { timeout, signal });
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			const truncation = truncateTail(output);

			if (truncation.truncated && executor.saveOutput) {
				try {
					tempFilePath = await executor.saveOutput(output, signal);
				} catch {
					signal?.throwIfAborted();
					// A failed spill must not hide the captured output or the original exit code.
				}
			}

			let outputText = truncation.content || "(no output)";

			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath: tempFilePath,
				};

				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;
				const spillNotice = tempFilePath ? `Full output: ${tempFilePath}` : "Full output could not be saved.";

				if (truncation.lastLinePartial) {
					const lastLineSize = formatSize(Buffer.byteLength(output.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). ${spillNotice}]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. ${spillNotice}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). ${spillNotice}]`;
				}
			}

			if (result.code !== 0) {
				throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
