import { closeSync, readdirSync, readSync, writeFileSync } from "fs";
import { join } from "path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { ensureWorkspaceDirectoriesAreSafe, WorkspaceBootstrapSecurityError } from "./workspace-bootstrap.js";
import { inspectWorkspaceEntry, openWorkspaceFile, UnsafeWorkspaceEntry } from "./workspace-files.js";

const MEMORY_FILE = "MEMORY.md";
const SKILLS_DIR = "skills";
const MAX_MEMORY_BYTES = 80_000;
const MAX_SKILL_METADATA_BYTES = 1024 * 1024;
const SKILL_IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"];

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
	if (workspace === "") throw new WorkspaceBootstrapSecurityError("Workspace path must not be empty.");
	const name = String(chatId);
	// Use ASCII so filesystem-specific Unicode aliases cannot collide with shared paths.
	if (!name || name === "." || name === ".." || /[^A-Za-z0-9._-]/.test(name)) {
		throw new WorkspaceBootstrapSecurityError("Chat ID must be a single directory name using only ASCII letters, digits, hyphens, underscores, or periods.");
	}
	if ([MEMORY_FILE, SKILLS_DIR].some((reserved) => reserved.toLowerCase() === name.toLowerCase())) {
		throw new WorkspaceBootstrapSecurityError(`Chat ID ${JSON.stringify(name)} conflicts with a reserved workspace name.`);
	}
	const chatDir = join(workspace, name);
	const paths: ChatPaths = {
		workspace,
		chatDir,
		memoryFile: join(chatDir, MEMORY_FILE),
		contextFile: join(chatDir, "context.jsonl"),
		skillsDir: join(chatDir, SKILLS_DIR),
		scratchDir: join(chatDir, "scratch"),
		attachmentsDir: join(chatDir, "attachments"),
	};
	ensureWorkspaceDirectoriesAreSafe([join(workspace, SKILLS_DIR), paths.skillsDir, paths.scratchDir, paths.attachmentsDir]);
	touchFile(join(workspace, MEMORY_FILE));
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
	const globalMem = tryRead(join(paths.workspace, MEMORY_FILE));
	if (globalMem) parts.push(`<global_memory>\n${globalMem}\n</global_memory>`);
	const chatMem = tryRead(paths.memoryFile);
	if (chatMem) parts.push(`<chat_memory>\n${chatMem}\n</chat_memory>`);
	return parts.length === 0 ? "(no working memory yet)" : parts.join("\n\n");
}

function tryRead(path: string): string {
	let fd: number | undefined;
	try {
		({ fd } = openWorkspaceFile(path));
		const buffer = Buffer.alloc(MAX_MEMORY_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, length);
			if (count === 0) break;
			length += count;
		}
		const content = buffer.toString("utf8", 0, Math.min(length, MAX_MEMORY_BYTES)).trim();
		return length > MAX_MEMORY_BYTES ? `${content}\n[truncated: MEMORY.md exceeds the prompt limit]` : content;
	} catch (error) {
		if (error instanceof UnsafeWorkspaceEntry || ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return "";
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function isSafeSkillScope(dir: string): boolean {
	try {
		if (!inspectWorkspaceEntry(dir)?.isDirectory()) return false;
		const directories = [dir];
		while (directories.length > 0) {
			const current = directories.pop()!;
			// Pi probes these exact paths, including on case-insensitive filesystems.
			for (const name of SKILL_IGNORE_FILES) {
				const entry = inspectWorkspaceEntry(join(current, name));
				if (entry && (!entry.isFile() || entry.size > BigInt(MAX_SKILL_METADATA_BYTES))) return false;
			}
			for (const name of readdirSync(current)) {
				if (name.startsWith(".") || name === "node_modules") continue;
				const path = join(current, name);
				const entry = inspectWorkspaceEntry(path);
				if (!entry) continue;
				if (entry.isDirectory()) directories.push(path);
				else if (name.endsWith(".md") && entry.size > BigInt(MAX_SKILL_METADATA_BYTES)) return false;
			}
		}
		return true;
	} catch (error) {
		if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
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

	for (const [dir, source] of [[join(paths.workspace, SKILLS_DIR), "workspace"], [paths.skillsDir, "chat"]] as const) {
		// Pi reads the files by path; validate the scope before passing it to the loader.
		if (!isSafeSkillScope(dir)) continue;
		for (const s of loadSkillsFromDir({ dir, source }).skills) map.set(s.name, apply(s));
	}
	return Array.from(map.values());
}
