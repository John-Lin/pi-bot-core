import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";

/**
 * Platform-agnostic message log used by all pi bots (mom/Slack, Telegram,
 * Discord). Pulled out of pi-telegram-bot's `TelegramStore` and pi-mono/mom's
 * `ChannelStore`, both of which carried the same JSONL schema, dedupe map, and
 * "append a line per message" surface.
 *
 * `id` is the platform-specific channel/chat key as a string (Slack channel id,
 * Telegram chat id stringified, Discord snowflake). Wrapper stores translate
 * their native id type at the call site so this module stays platform-free.
 *
 * `ts` is opaque: the platform's own message id (Slack ts, Telegram message_id,
 * Discord snowflake). We do NOT parse it as a time — bots that want
 * `LoggedMessage.date` to derive from `ts` (Slack does, Discord can via
 * snowflake) must fill `date` themselves before calling. When `date` is empty
 * we stamp current ISO time, matching pi-telegram-bot's prior behavior.
 */

export interface Attachment {
	/** Original filename supplied by the platform. */
	original: string;
	/** Path relative to `workingDir`, e.g. `"<id>/attachments/<file>"`. */
	local: string;
}

export interface LoggedMessage {
	/** ISO 8601. Auto-filled with current time when caller leaves it empty. */
	date: string;
	/** Platform-native message id (Slack ts, Telegram message_id, Discord snowflake). */
	ts: string;
	/** Platform user id, or `"bot"` for the bot's own replies. */
	user: string;
	userName?: string;
	displayName?: string;
	text: string;
	attachments: Attachment[];
	isBot: boolean;
}

export interface MessageLogConfig {
	/** Absolute path that all per-id directories live under. */
	workingDir: string;
}

export class MessageLog {
	private workingDir: string;
	// Key: `<id>:<ts>`. Entries auto-evict 60s after insertion to bound memory
	// without forfeiting protection against the realistic "platform redelivers
	// the same event" race window.
	private recentlyLogged = new Map<string, number>();

	constructor(config: MessageLogConfig) {
		this.workingDir = config.workingDir;
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	/**
	 * Append a JSONL line to `<workingDir>/<id>/log.jsonl`. Returns false when
	 * the same `id:ts` was logged within the last 60s, so callers can branch
	 * on dedupe ("already saw this — skip the side effects").
	 */
	async logMessage(id: string, message: LoggedMessage): Promise<boolean> {
		const dedupeKey = `${id}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) return false;
		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60_000);

		if (!message.date) {
			message.date = new Date().toISOString();
		}

		const dir = join(this.workingDir, id);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const logPath = join(dir, "log.jsonl");
		await appendFile(logPath, `${JSON.stringify(message)}\n`, "utf-8");
		return true;
	}

	/**
	 * Convenience wrapper: log the bot's own outgoing message. `ts` is whatever
	 * id the platform returned for the sent message (so a future ingest of the
	 * same message — e.g. via Slack's history backfill — dedupes against this
	 * entry).
	 */
	async logBotResponse(id: string, text: string, ts: string): Promise<void> {
		await this.logMessage(id, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/**
	 * Read the `ts` of the last appended line for `id`. Returns null when the
	 * log doesn't exist or the last line cannot be parsed (malformed file
	 * shouldn't crash callers — backfill treats null as "start from scratch").
	 */
	getLastTimestamp(id: string): string | null {
		const logPath = join(this.workingDir, id, "log.jsonl");
		if (!existsSync(logPath)) return null;
		try {
			const content = readFileSync(logPath, "utf-8").trim();
			if (!content) return null;
			const lines = content.split("\n");
			const lastLine = lines[lines.length - 1];
			if (!lastLine) return null;
			const last = JSON.parse(lastLine) as LoggedMessage;
			return last.ts;
		} catch {
			return null;
		}
	}
}
