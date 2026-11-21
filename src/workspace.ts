import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { ensureWorkspaceDirectoriesAreSafe } from "./workspace-bootstrap.js";

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
 * `<workspace>/<chatId>/{MEMORY.md, attachments/, scratch/, skills/}` after
 * checking all directory paths for symbolic links and non-directory components.
 */
export function ensureChatDir(workspace: string, chatId: number | string): ChatPaths {
	const chatDir = join(workspace, String(chatId));
	const paths: ChatPaths = {
		workspace,
		chatDir,
		memoryFile: join(chatDir, "MEMORY.md"),
		contextFile: join(chatDir, "context.jsonl"),
		skillsDir: join(chatDir, "skills"),
		scratchDir: join(chatDir, "scratch"),
		attachmentsDir: join(chatDir, "attachments"),
	};
	ensureWorkspaceDirectoriesAreSafe([join(workspace, "skills"), paths.skillsDir, paths.scratchDir, paths.attachmentsDir]);
	touchFile(join(workspace, "MEMORY.md"));
	touchFile(paths.memoryFile);
	return paths;
}

function touchFile(path: string): void {
	try {
		writeFileSync(path, "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
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
 * When given a guest workspace root, rewrite skill paths so workspace tools can open them in the VM.
 */
export function loadChatSkills(paths: ChatPaths, guestWorkspace?: string): Skill[] {
	const map = new Map<string, Skill>();
	const translate = (hostPath: string): string =>
		guestWorkspace && guestWorkspace !== paths.workspace && hostPath.startsWith(paths.workspace)
			? guestWorkspace + hostPath.slice(paths.workspace.length)
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
