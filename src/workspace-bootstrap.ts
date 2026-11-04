import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	mkdirSync,
	writeFileSync,
} from "fs";
import { join, parse, resolve, sep } from "path";

const MAX_BOOTSTRAP_FILE_CHARS = 20_000;

export class WorkspaceBootstrapSecurityError extends Error {
	constructor(message = "Cannot safely load workspace bootstrap files: fs.constants.O_NOFOLLOW is not supported on this platform.") {
		super(message);
		this.name = "WorkspaceBootstrapSecurityError";
	}
}

const BOOTSTRAP_FILES = [
	["AGENTS.md", "agents_md", "# Agent Instructions\n", MAX_BOOTSTRAP_FILE_CHARS],
	["SOUL.md", "soul_md", "# Persona\n", MAX_BOOTSTRAP_FILE_CHARS],
	["IDENTITY.md", "identity_md", "# Identity\n", MAX_BOOTSTRAP_FILE_CHARS],
	["USER.md", "user_md", "# User Preferences\n", 4_000],
] as const;

/** Ensure the workspace exists without traversing a persistent linked path component. */
export function ensureWorkspacePathIsSafe(workspace: string): void {
	assertNoFollowSupport();
	const absolute = resolve(workspace);
	const root = parse(absolute).root;
	let current = root;
	for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			const stats = lstatSync(current);
			if (stats.isSymbolicLink() || !stats.isDirectory()) throw unsafeWorkspacePathError();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			mkdirSync(absolute, { recursive: true });
			break;
		}
	}
	if (inspectWorkspacePath(workspace) === undefined) throw unsafeWorkspacePathError();
}

/** Seed shared workspace instructions and preferences without replacing existing files. */
export function ensureWorkspaceBootstrap(workspace: string): void {
	const workspaceIdentity = inspectWorkspacePath(workspace);
	if (workspaceIdentity === undefined) return;
	for (const [name, , starter] of BOOTSTRAP_FILES) {
		if (!workspacePathIsUnchanged(workspaceIdentity)) return;
		try {
			writeFileSync(join(workspace, name), starter, { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

interface PathIdentity {
	path: string;
	device: bigint;
	inode: bigint;
}

function inspectWorkspacePath(workspace: string): PathIdentity[] | undefined {
	const absolute = resolve(workspace);
	const root = parse(absolute).root;
	const identities: PathIdentity[] = [];
	let current = root;
	for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			const stats = lstatSync(current, { bigint: true });
			if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
			identities.push({ path: current, device: stats.dev, inode: stats.ino });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	return identities;
}

function workspacePathIsUnchanged(identities: PathIdentity[]): boolean {
	try {
		return identities.every((identity) => {
			const stats = lstatSync(identity.path, { bigint: true });
			return !stats.isSymbolicLink() &&
				stats.isDirectory() &&
				stats.dev === identity.device &&
				stats.ino === identity.inode;
		});
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

function readBoundedUtf8(fd: number, fileSize: number, maxChars: number): {
	content: string;
	truncated: boolean;
} {
	const buffer = Buffer.alloc(Math.min(fileSize, maxChars * 4));
	let bytesRead = 0;
	while (bytesRead < buffer.length) {
		const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
		if (count === 0) break;
		bytesRead += count;
	}
	const characters = Array.from(buffer.toString("utf8", 0, bytesRead));
	return {
		content: characters.slice(0, maxChars).join("").trim(),
		truncated: fileSize > bytesRead || characters.length > maxChars,
	};
}

function assertNoFollowSupport(): number {
	const noFollow = constants.O_NOFOLLOW as number | undefined;
	if (typeof noFollow !== "number" || noFollow === 0) throw new WorkspaceBootstrapSecurityError();
	return noFollow;
}

function unsafeWorkspacePathError(): WorkspaceBootstrapSecurityError {
	return new WorkspaceBootstrapSecurityError(
		"Cannot safely use workspace: the path or one of its parents is a symbolic link.",
	);
}

/** Read shared workspace instructions and preferences for each agent run. */
export function readWorkspaceBootstrap(workspace: string, visibleWorkspace: string): string {
	const noFollow = assertNoFollowSupport();
	const workspaceIdentity = inspectWorkspacePath(workspace);
	return BOOTSTRAP_FILES.map(([name, tag, , maxChars]) => {
		const path = join(workspace, name);
		let content = "";
		let truncated = false;
		let fd: number | undefined;
		try {
			if (workspaceIdentity === undefined || !workspacePathIsUnchanged(workspaceIdentity)) {
				return `### ${visibleWorkspace}/${name}\n<${tag}>\n\n</${tag}>`;
			}
			// The host assembles this prompt even in Docker mode; read only the opened regular file.
			fd = openSync(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
			const stats = fstatSync(fd);
			if (stats.isFile() && workspacePathIsUnchanged(workspaceIdentity)) {
				const result = readBoundedUtf8(fd, stats.size, maxChars);
				if (workspacePathIsUnchanged(workspaceIdentity)) {
					content = result.content;
					truncated = result.truncated;
				}
			}
		} catch (error) {
			if (!["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
		if (truncated) {
			content = `${content}\n[truncated: read ${visibleWorkspace}/${name} for the rest]`;
		}
		return `### ${visibleWorkspace}/${name}\n<${tag}>\n${content}\n</${tag}>`;
	}).join("\n\n");
}
