import { compile, int, obj, opt } from "@earendil-works/pi-schema";
import { readFileSync } from "fs";

const agentSettingsSchema = obj({
	contextWindow: opt(int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	compaction: opt(obj({
		reserveTokens: opt(int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		keepRecentTokens: opt(int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	})),
});

const validator = compile(agentSettingsSchema);

/**
 * Load bot-owned agent tuning without coercion or implicit defaults.
 * Keep the context-window override separate from the settings passed to Pi's
 * SettingsManager so the bot can apply it to the resolved model instead.
 */
export function loadAgentSettings(path: string) {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`Cannot read agent settings ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		// JSON parser errors can include file contents; report only the source path.
		throw new Error(`Invalid agent settings ${path}: invalid JSON`);
	}

	if (!validator.check(parsed)) {
		const errors = validator.errors(parsed).map((error) => `- ${error.path || "/"}: ${error.message}`);
		throw new Error(`Invalid agent settings ${path}:\n${errors.join("\n")}`);
	}

	const { contextWindow, ...settings } = parsed;
	return { contextWindow, settings };
}
