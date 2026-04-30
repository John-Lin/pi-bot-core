import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MessageLog } from "../src/message-log.js";

let ws: string;

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "pi-bot-ml-"));
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
});

describe("logMessage", () => {
	test("appends a JSONL line and creates the per-id directory on first write", async () => {
		const ml = new MessageLog({ workingDir: ws });
		const ok = await ml.logMessage("123", {
			date: "",
			ts: "42",
			user: "u1",
			userName: "john",
			text: "hi",
			attachments: [],
			isBot: false,
		});
		expect(ok).toBe(true);
		const path = join(ws, "123", "log.jsonl");
		expect(existsSync(path)).toBe(true);
		const entry = JSON.parse(readFileSync(path, "utf8").trim());
		expect(entry.text).toBe("hi");
		expect(entry.userName).toBe("john");
	});

	test("auto-fills date with current ISO time when caller leaves it empty", async () => {
		const ml = new MessageLog({ workingDir: ws });
		const before = Date.now();
		await ml.logMessage("123", {
			date: "",
			ts: "42",
			user: "u",
			text: "hi",
			attachments: [],
			isBot: false,
		});
		const after = Date.now();
		const entry = JSON.parse(readFileSync(join(ws, "123", "log.jsonl"), "utf8").trim());
		expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		const t = Date.parse(entry.date);
		expect(t).toBeGreaterThanOrEqual(before);
		expect(t).toBeLessThanOrEqual(after);
	});

	test("preserves caller-supplied date verbatim", async () => {
		const ml = new MessageLog({ workingDir: ws });
		await ml.logMessage("123", {
			date: "2025-01-02T03:04:05.000Z",
			ts: "42",
			user: "u",
			text: "hi",
			attachments: [],
			isBot: false,
		});
		const entry = JSON.parse(readFileSync(join(ws, "123", "log.jsonl"), "utf8").trim());
		expect(entry.date).toBe("2025-01-02T03:04:05.000Z");
	});

	test("dedupes on id:ts within the 60s window", async () => {
		const ml = new MessageLog({ workingDir: ws });
		const msg = {
			date: "",
			ts: "42",
			user: "u",
			text: "hi",
			attachments: [],
			isBot: false,
		};
		expect(await ml.logMessage("123", { ...msg })).toBe(true);
		expect(await ml.logMessage("123", { ...msg })).toBe(false);
	});

	test("dedupe is scoped per id (different id, same ts is allowed)", async () => {
		const ml = new MessageLog({ workingDir: ws });
		const msg = {
			date: "",
			ts: "42",
			user: "u",
			text: "hi",
			attachments: [],
			isBot: false,
		};
		expect(await ml.logMessage("123", { ...msg })).toBe(true);
		expect(await ml.logMessage("456", { ...msg })).toBe(true);
	});

	test("appends multiple distinct entries to the same id", async () => {
		const ml = new MessageLog({ workingDir: ws });
		await ml.logMessage("123", { date: "", ts: "1", user: "u", text: "a", attachments: [], isBot: false });
		await ml.logMessage("123", { date: "", ts: "2", user: "u", text: "b", attachments: [], isBot: false });
		const lines = readFileSync(join(ws, "123", "log.jsonl"), "utf8").trim().split("\n");
		expect(lines.length).toBe(2);
		expect(JSON.parse(lines[0]!).ts).toBe("1");
		expect(JSON.parse(lines[1]!).ts).toBe("2");
	});
});

describe("logBotResponse", () => {
	test("writes an isBot=true entry with user='bot'", async () => {
		const ml = new MessageLog({ workingDir: ws });
		await ml.logBotResponse("123", "reply", "99");
		const entry = JSON.parse(readFileSync(join(ws, "123", "log.jsonl"), "utf8").trim());
		expect(entry.isBot).toBe(true);
		expect(entry.user).toBe("bot");
		expect(entry.text).toBe("reply");
		expect(entry.ts).toBe("99");
		expect(entry.attachments).toEqual([]);
		expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

describe("getLastTimestamp", () => {
	test("returns null when no log exists for the id", () => {
		const ml = new MessageLog({ workingDir: ws });
		expect(ml.getLastTimestamp("123")).toBe(null);
	});

	test("returns the ts of the last appended line", async () => {
		const ml = new MessageLog({ workingDir: ws });
		await ml.logMessage("123", { date: "", ts: "1", user: "u", text: "a", attachments: [], isBot: false });
		await ml.logMessage("123", { date: "", ts: "2", user: "u", text: "b", attachments: [], isBot: false });
		expect(ml.getLastTimestamp("123")).toBe("2");
	});

	test("returns null on a malformed last line rather than throwing", async () => {
		const ml = new MessageLog({ workingDir: ws });
		await ml.logMessage("123", { date: "", ts: "1", user: "u", text: "a", attachments: [], isBot: false });
		// Corrupt the file: append a non-JSON tail.
		const path = join(ws, "123", "log.jsonl");
		const { appendFileSync } = await import("fs");
		appendFileSync(path, "not-json\n");
		expect(ml.getLastTimestamp("123")).toBe(null);
	});
});
