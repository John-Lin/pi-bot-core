import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureChatDir, readMemory } from "../src/workspace.js";

let ws: string;

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "pi-bot-ws-"));
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
});

describe("ensureChatDir", () => {
	test("creates workspace root + per-chat skeleton", () => {
		const paths = ensureChatDir(ws, 123);
		expect(existsSync(join(ws, "MEMORY.md"))).toBe(true);
		expect(existsSync(join(ws, "skills"))).toBe(true);
		expect(existsSync(paths.chatDir)).toBe(true);
		expect(existsSync(paths.memoryFile)).toBe(true);
		expect(existsSync(paths.attachmentsDir)).toBe(true);
		expect(existsSync(paths.scratchDir)).toBe(true);
		expect(existsSync(paths.skillsDir)).toBe(true);
	});

	test("is idempotent and preserves MEMORY.md content", () => {
		const paths = ensureChatDir(ws, 123);
		writeFileSync(paths.memoryFile, "existing memory");
		ensureChatDir(ws, 123);
		expect(readFileSync(paths.memoryFile, "utf8")).toBe("existing memory");
	});
});

describe("readMemory", () => {
	test("returns placeholder when both memory files are empty", () => {
		const paths = ensureChatDir(ws, 42);
		expect(readMemory(paths)).toBe("(no working memory yet)");
	});

	test("wraps global + chat memory in XML fences", () => {
		const paths = ensureChatDir(ws, 42);
		writeFileSync(join(ws, "MEMORY.md"), "global-fact");
		writeFileSync(paths.memoryFile, "chat-fact");
		const mem = readMemory(paths);
		expect(mem).toContain("<global_memory>");
		expect(mem).toContain("global-fact");
		expect(mem).toContain("</global_memory>");
		expect(mem).toContain("<chat_memory>");
		expect(mem).toContain("chat-fact");
		expect(mem).toContain("</chat_memory>");
	});

	test("XML fence isolates user-authored Markdown headings", () => {
		const paths = ensureChatDir(ws, 42);
		writeFileSync(paths.memoryFile, "## Reply rules\nbe concise");
		const mem = readMemory(paths);
		// User content stays inside the fence; no bare h2/h3 can collide with system-prompt sections.
		expect(mem).toContain("<chat_memory>\n## Reply rules\nbe concise\n</chat_memory>");
	});
});
