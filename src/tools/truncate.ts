/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits — whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except the bash tail truncation edge case).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

interface TruncationMetrics {
	content: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
}

type TruncationLimit =
	| { truncatedBy: "lines"; lastLinePartial: false; firstLineExceedsLimit: false }
	| { truncatedBy: "bytes"; lastLinePartial: true; firstLineExceedsLimit: false }
	| { truncatedBy: "bytes"; lastLinePartial: false; firstLineExceedsLimit: boolean };

/** Tool details also accept truncation metadata from the Pi SDK. */
export interface TruncationResult extends TruncationMetrics {
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
}

type TruncationOutcome = TruncationMetrics & (
	| { truncated: false; truncatedBy: null; lastLinePartial: false; firstLineExceedsLimit: false }
	| ({ truncated: true } & TruncationLimit)
);

const LINE_LIMIT = { truncatedBy: "lines", lastLinePartial: false, firstLineExceedsLimit: false } satisfies TruncationLimit;
const BYTE_LIMIT = { truncatedBy: "bytes", lastLinePartial: false, firstLineExceedsLimit: false } satisfies TruncationLimit;

function untruncatedOutput(metrics: Pick<TruncationMetrics, "content" | "totalLines" | "totalBytes">): TruncationOutcome {
	return {
		...metrics,
		truncated: false,
		truncatedBy: null,
		outputLines: metrics.totalLines,
		outputBytes: metrics.totalBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If the first line exceeds the byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return untruncatedOutput({ content, totalLines, totalBytes });
	}

	const firstLine = lines[0] ?? "";
	const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
		} satisfies TruncationOutcome;
	}

	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let limit: TruncationLimit = LINE_LIMIT;

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);

		if (outputBytesCount + lineBytes > maxBytes) {
			limit = BYTE_LIMIT;
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		...limit,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
	} satisfies TruncationOutcome;
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return a partial first line if the last line of original content exceeds the byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return untruncatedOutput({ content, totalLines, totalBytes });
	}

	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let limit: TruncationLimit = LINE_LIMIT;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);

		if (outputBytesCount + lineBytes > maxBytes) {
			limit = BYTE_LIMIT;
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				limit = { ...BYTE_LIMIT, lastLinePartial: true };
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		...limit,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
	} satisfies TruncationOutcome;
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	let start = buf.length - maxBytes;
	while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}
