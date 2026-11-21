import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { ensureChatDir, readMemory } from "../src/workspace.js";
import { WorkspaceBootstrapSecurityError } from "../src/workspace-bootstrap.js";

let ws: string;

beforeEach(() => {
	ws = mkdtempSync(join(realpathSync(tmpdir()), "pi-bot-ws-"));
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

	for (const chatId of ["MEMORY.md", "memory.md", "skills", "SKILLS"]) {
		test(`rejects reserved chat directory name ${chatId} before writing`, () => {
			expect(() => ensureChatDir(ws, chatId)).toThrow(/reserved workspace name/);
			expect(readdirSync(ws)).toEqual([]);
		});
	}

	for (const chatId of ["", ".", "..", "nested/chat", "nested/../MEMORY.md"]) {
		test(`rejects chat ID ${JSON.stringify(chatId)} that is not a single directory name`, () => {
			const workspace = join(ws, "workspace");
			expect(() => ensureChatDir(workspace, chatId)).toThrow(/single directory name/);
			expect(readdirSync(ws)).toEqual([]);
		});
	}

	for (const linkedPath of ["workspace", "workspace/skills", "workspace/123", "workspace/123/attachments", "workspace/123/scratch", "workspace/123/skills"]) {
		test(`rejects a linked ${linkedPath} before initializing the skeleton`, () => {
			const external = join(ws, "external");
			const workspace = join(ws, "workspace");
			const link = join(ws, linkedPath);
			mkdirSync(external);
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(external, link);
			const before = readdirSync(ws, { recursive: true }).sort();

			expect(() => ensureChatDir(workspace, 123)).toThrow(WorkspaceBootstrapSecurityError);
			expect(readdirSync(ws, { recursive: true }).sort()).toEqual(before);
		});
	}

	test("does not create a memory file through a dangling symlink", () => {
		const paths = ensureChatDir(ws, 123);
		const target = join(ws, "unexpected.txt");
		rmSync(paths.memoryFile);
		symlinkSync(target, paths.memoryFile);
		ensureChatDir(ws, 123);
		expect(existsSync(target)).toBe(false);
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
