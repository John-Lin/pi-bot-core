import chalk from "chalk";

/**
 * Platform-agnostic logger factory.
 *
 * Each bot defines its own `LogContext` shape (Discord channel/guild names vs
 * Telegram chat/user identifiers) and supplies a `formatContext` that turns
 * it into the per-line `[...]` prefix. Everything else — chalk colours,
 * timestamps, `[system]` warnings, the usage-summary breakdown — is shared.
 *
 * Returned shape is a plain object of standalone functions (no `this`),
 * so call sites can `import * as log` and destructure freely.
 */

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface LoggerOptions<TLogContext> {
	/** Format a context into the per-line `[prefix]` segment (e.g. `[mysrv#general:alice]`). */
	formatContext: (ctx: TLogContext) => string;
	/**
	 * Markdown bold wrapper used in the string returned by {@link Logger.logUsageSummary}.
	 * Defaults to `**text**` (Discord / CommonMark). Telegram bots pass a `*text*` wrapper.
	 */
	formatBold?: (text: string) => string;
}

export interface Logger<TLogContext> {
	logUserMessage(ctx: TLogContext, text: string): void;
	logToolStart(ctx: TLogContext, toolName: string, label: string, args: Record<string, unknown>): void;
	logToolSuccess(ctx: TLogContext, toolName: string, durationMs: number, result: string): void;
	logToolError(ctx: TLogContext, toolName: string, durationMs: number, error: string): void;
	logLlmCallStart(ctx: TLogContext): void;
	logLlmCallEnd(ctx: TLogContext, durationMs: number): void;
	logResponseStart(ctx: TLogContext, ttftMs?: number): void;
	logThinking(ctx: TLogContext, thinking: string): void;
	logResponse(ctx: TLogContext, text: string): void;
	logDownloadStart(ctx: TLogContext, filename: string, localPath: string): void;
	logDownloadSuccess(ctx: TLogContext, sizeKB: number): void;
	logDownloadError(ctx: TLogContext, filename: string, error: string): void;
	logStopRequest(ctx: TLogContext): void;
	logInfo(message: string): void;
	logWarning(message: string, details?: string): void;
	logAgentError(ctx: TLogContext | "system", error: string): void;
	logUsageSummary(
		ctx: TLogContext,
		usage: UsageTotals,
		contextTokens?: number,
		contextWindow?: number,
	): string;
}

function timestamp(): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `[${hh}:${mm}:${ss}]`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen)}\n(truncated at ${maxLen} chars)`;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((l) => `           ${l}`)
		.join("\n");
}

function formatToolArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;
		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}
		if (key === "offset" || key === "limit") continue;
		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}
	return lines.join("\n");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function createLogger<TLogContext>(opts: LoggerOptions<TLogContext>): Logger<TLogContext> {
	const formatContext = opts.formatContext;
	const bold = opts.formatBold ?? ((t: string) => `**${t}**`);

	const logUserMessage: Logger<TLogContext>["logUserMessage"] = (ctx, text) => {
		console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} ${text}`));
	};

	const logToolStart: Logger<TLogContext>["logToolStart"] = (ctx, toolName, label, args) => {
		const formattedArgs = formatToolArgs(args);
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ↳ ${toolName}: ${label}`));
		if (formattedArgs) {
			console.log(chalk.dim(indent(formattedArgs)));
		}
	};

	const logToolSuccess: Logger<TLogContext>["logToolSuccess"] = (ctx, toolName, durationMs, result) => {
		const duration = (durationMs / 1000).toFixed(1);
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✓ ${toolName} (${duration}s)`));
		const truncated = truncate(result, 1000);
		if (truncated) {
			console.log(chalk.dim(indent(truncated)));
		}
	};

	const logToolError: Logger<TLogContext>["logToolError"] = (ctx, toolName, durationMs, error) => {
		const duration = (durationMs / 1000).toFixed(1);
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✗ ${toolName} (${duration}s)`));
		console.log(chalk.dim(indent(truncate(error, 1000))));
	};

	const logLlmCallStart: Logger<TLogContext>["logLlmCallStart"] = (ctx) => {
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ⏱ Calling LLM API...`));
	};

	const logLlmCallEnd: Logger<TLogContext>["logLlmCallEnd"] = (ctx, durationMs) => {
		const duration = (durationMs / 1000).toFixed(1);
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ← LLM API done (${duration}s total)`));
	};

	const logResponseStart: Logger<TLogContext>["logResponseStart"] = (ctx, ttftMs) => {
		const suffix = ttftMs !== undefined ? ` (TTFT ${(ttftMs / 1000).toFixed(1)}s)` : "";
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} → Streaming response...${suffix}`));
	};

	const logThinking: Logger<TLogContext>["logThinking"] = (ctx, thinking) => {
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💭 Thinking`));
		console.log(chalk.dim(indent(truncate(thinking, 1000))));
	};

	const logResponse: Logger<TLogContext>["logResponse"] = (ctx, text) => {
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💬 Response`));
		console.log(chalk.dim(indent(truncate(text, 1000))));
	};

	const logDownloadStart: Logger<TLogContext>["logDownloadStart"] = (ctx, filename, localPath) => {
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ↓ Downloading attachment`));
		console.log(chalk.dim(`           ${filename} → ${localPath}`));
	};

	const logDownloadSuccess: Logger<TLogContext>["logDownloadSuccess"] = (ctx, sizeKB) => {
		console.log(
			chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✓ Downloaded (${sizeKB.toLocaleString()} KB)`),
		);
	};

	const logDownloadError: Logger<TLogContext>["logDownloadError"] = (ctx, filename, error) => {
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✗ Download failed`));
		console.log(chalk.dim(`           ${filename}: ${error}`));
	};

	const logStopRequest: Logger<TLogContext>["logStopRequest"] = (ctx) => {
		console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} stop`));
		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ⊗ Stop requested - aborting`));
	};

	const logInfo: Logger<TLogContext>["logInfo"] = (message) => {
		console.log(chalk.blue(`${timestamp()} [system] ${message}`));
	};

	const logWarning: Logger<TLogContext>["logWarning"] = (message, details) => {
		console.log(chalk.yellow(`${timestamp()} [system] ⚠ ${message}`));
		if (details) {
			console.log(chalk.dim(indent(details)));
		}
	};

	const logAgentError: Logger<TLogContext>["logAgentError"] = (ctx, error) => {
		const context = ctx === "system" ? "[system]" : formatContext(ctx);
		console.log(chalk.yellow(`${timestamp()} ${context} ✗ Agent error`));
		console.log(chalk.dim(indent(error)));
	};

	const logUsageSummary: Logger<TLogContext>["logUsageSummary"] = (
		ctx,
		usage,
		contextTokens,
		contextWindow,
	) => {
		const lines: string[] = [];
		lines.push(bold("Usage Summary"));
		lines.push(`Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`);
		if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
			lines.push(
				`Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} write`,
			);
		}
		if (contextTokens && contextWindow) {
			const contextPercent = ((contextTokens / contextWindow) * 100).toFixed(1);
			lines.push(
				`Context: ${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} (${contextPercent}%)`,
			);
		}
		lines.push(
			`Cost: $${usage.cost.input.toFixed(4)} in, $${usage.cost.output.toFixed(4)} out` +
				(usage.cacheRead > 0 || usage.cacheWrite > 0
					? `, $${usage.cost.cacheRead.toFixed(4)} cache read, $${usage.cost.cacheWrite.toFixed(4)} cache write`
					: ""),
		);
		lines.push(bold(`Total: $${usage.cost.total.toFixed(4)}`));

		const summary = lines.join("\n");

		console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💰 Usage`));
		console.log(
			chalk.dim(
				`           ${usage.input.toLocaleString()} in + ${usage.output.toLocaleString()} out` +
					(usage.cacheRead > 0 || usage.cacheWrite > 0
						? ` (${usage.cacheRead.toLocaleString()} cache read, ${usage.cacheWrite.toLocaleString()} cache write)`
						: "") +
					` = $${usage.cost.total.toFixed(4)}`,
			),
		);

		return summary;
	};

	return {
		logUserMessage,
		logToolStart,
		logToolSuccess,
		logToolError,
		logLlmCallStart,
		logLlmCallEnd,
		logResponseStart,
		logThinking,
		logResponse,
		logDownloadStart,
		logDownloadSuccess,
		logDownloadError,
		logStopRequest,
		logInfo,
		logWarning,
		logAgentError,
		logUsageSummary,
	};
}
