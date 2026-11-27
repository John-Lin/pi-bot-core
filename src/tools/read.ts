import { extname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Executor } from "../sandbox.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] ?? null;
}

const readSchema = obj({
	label: str({ description: "Brief description of what you're reading and why (shown to user)" }),
	path: str({ description: "Path to the file to read (relative or absolute)" }),
	offset: opt(num({ description: "Line number to start reading from (1-indexed)" })),
	limit: opt(num({ description: "Maximum number of lines to read" })),
}, { open: true });

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export function createReadTool(executor: Executor): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId,
			{ path, offset, limit },
			signal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			const mimeType = isImageFile(path);

			if (mimeType) {
				const result = await executor.exec(`base64 < ${shellEscape(path)}`, { signal });
				if (result.code !== 0) {
					throw new Error(result.stderr || `Failed to read file: ${path}`);
				}
				const base64 = result.stdout.replace(/\s/g, "");

				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: base64, mimeType },
					],
					details: undefined,
				};
			}

			if (offset !== undefined && !Number.isSafeInteger(offset)) throw new Error("Read offset must be an integer");
			if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Read limit must be a positive integer");

			const file = shellEscape(path);
			const countResult = await executor.exec(`wc -lc < ${file} && tail -c 1 < ${file}`, { signal });
			if (countResult.code !== 0) {
				throw new Error(countResult.stderr || `Failed to read file: ${path}`);
			}
			const counts = /^\s*(\d+)\s+(\d+)\n/.exec(countResult.stdout);
			if (!counts) throw new Error(`Failed to count lines and bytes: ${path}`);
			const totalFileBytes = Number(counts[2]);
			// wc counts newlines; tail tells us whether the last line is unterminated.
			const totalFileLines = Number(counts[1]) + Number(totalFileBytes > 0 && !countResult.stdout.endsWith("\n\n"));

			const startLine = Math.max(1, offset ?? 1);
			if (startLine > Math.max(1, totalFileLines)) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
			}

			// Keep a sentinel line/byte beyond the limits, allowing for the final newline.
			const sampleLines = Math.min(limit ?? DEFAULT_MAX_LINES + 1, DEFAULT_MAX_LINES + 1);
			const skipLines = startLine === 1 ? "" : `tail -n +${startLine} | `;
			const cmd = `exec < ${file} || exit $?; ${skipLines}head -n ${sampleLines} | head -c ${DEFAULT_MAX_BYTES + 2}`;
			const result = await executor.exec(cmd, { signal });
			// Early pipe closure is normal at the cap; upstream utilities report read failures on stderr.
			if (result.code !== 0 || result.stderr) {
				throw new Error(result.stderr || `Failed to read file: ${path}`);
			}

			// The final separator does not count as an extra line.
			const sample = result.stdout.replace(/\n$/, "");
			const truncation = truncateHead(sample);
			const details: ReadToolDetails | undefined = truncation.truncated
				? { truncation: { ...truncation, totalLines: totalFileLines, totalBytes: totalFileBytes } }
				: undefined;
			let outputText: string;

			if (truncation.firstLineExceedsLimit) {
				outputText = `[Line ${startLine} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLine}p' < ${shellEscape(path)} | head -c ${DEFAULT_MAX_BYTES}]`;
			} else if (truncation.truncated) {
				const endLineDisplay = startLine + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;

				outputText = truncation.content;

				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
			} else if (limit !== undefined) {
				const nextOffset = startLine + limit;
				const remaining = totalFileLines - nextOffset + 1;
				outputText = remaining > 0
					? `${sample}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`
					: sample;
			} else {
				outputText = Buffer.byteLength(result.stdout) <= DEFAULT_MAX_BYTES ? result.stdout : sample;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
	};
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
