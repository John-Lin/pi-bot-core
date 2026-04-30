import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";

const PER_CHAT_SUBDIRS = ["attachments", "scratch", "skills"] as const;

export interface ChatPaths {
	workspace: string;
	chatDir: string;
	memoryFile: string;
	contextFile: string;
	skillsDir: string;
	scratchDir: string;
	attachmentsDir: string;
}

/**
 * Ensure the workspace root and per-chat directory skeleton exist.
 * Creates `<workspace>/{MEMORY.md, skills/}` and
 * `<workspace>/<chatId>/{MEMORY.md, attachments/, scratch/, skills/}`.
 */
export function ensureChatDir(workspace: string, chatId: number | string): ChatPaths {
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(workspace, "skills"), { recursive: true });
	touchFile(join(workspace, "MEMORY.md"));

	const chatDir = join(workspace, String(chatId));
	for (const sub of PER_CHAT_SUBDIRS) {
		mkdirSync(join(chatDir, sub), { recursive: true });
	}
	touchFile(join(chatDir, "MEMORY.md"));

	return {
		workspace,
		chatDir,
		memoryFile: join(chatDir, "MEMORY.md"),
		contextFile: join(chatDir, "context.jsonl"),
		skillsDir: join(chatDir, "skills"),
		scratchDir: join(chatDir, "scratch"),
		attachmentsDir: join(chatDir, "attachments"),
	};
}

function touchFile(path: string): void {
	if (!existsSync(path)) writeFileSync(path, "");
}

/**
 * Concatenate global + per-chat MEMORY.md contents. Returns a placeholder when both are empty.
 *
 * Wraps each file's content in an XML-style fence so user-authored Markdown headings inside
 * MEMORY.md cannot collide with the surrounding system-prompt heading hierarchy and appear as
 * top-level system sections to the LLM.
 */
export function readMemory(paths: ChatPaths): string {
	const parts: string[] = [];
	const globalMem = tryRead(join(paths.workspace, "MEMORY.md"));
	if (globalMem) parts.push(`<global_memory>\n${globalMem}\n</global_memory>`);
	const chatMem = tryRead(paths.memoryFile);
	if (chatMem) parts.push(`<chat_memory>\n${chatMem}\n</chat_memory>`);
	return parts.length === 0 ? "(no working memory yet)" : parts.join("\n\n");
}

function tryRead(path: string): string {
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf8").trim();
}

/**
 * Load skills from both the global workspace and this chat's skill dir. Per-chat overrides global on name collision.
 *
 * When `containerWorkspace` differs from `paths.workspace`, skill paths are rewritten from the host
 * view to the container view so that the LLM (which invokes skills via bash inside the container)
 * sees paths that actually exist in its filesystem. This mirrors pi-mom's `loadMomSkills`.
 */
export function loadChatSkills(paths: ChatPaths, containerWorkspace?: string): Skill[] {
	const map = new Map<string, Skill>();
	const translate = (hostPath: string): string =>
		containerWorkspace && containerWorkspace !== paths.workspace && hostPath.startsWith(paths.workspace)
			? containerWorkspace + hostPath.slice(paths.workspace.length)
			: hostPath;

	const apply = (s: Skill): Skill => ({
		...s,
		filePath: translate(s.filePath),
		baseDir: translate(s.baseDir),
	});

	const globalSkillsDir = join(paths.workspace, "skills");
	for (const s of loadSkillsFromDir({ dir: globalSkillsDir, source: "workspace" }).skills) {
		map.set(s.name, apply(s));
	}
	for (const s of loadSkillsFromDir({ dir: paths.skillsDir, source: "chat" }).skills) {
		map.set(s.name, apply(s));
	}
	return Array.from(map.values());
}
