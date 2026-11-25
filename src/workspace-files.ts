import { closeSync, constants, fstatSync, lstatSync, openSync, type BigIntStats } from "node:fs";
import { constants as osConstants } from "node:os";
import { join, parse, resolve, sep } from "node:path";

export class UnsafeWorkspaceEntry extends Error {
	readonly code = "EACCES";
	readonly errno = osConstants.errno.EACCES;

	constructor() {
		super("unsafe workspace entry: expected an ordinary directory or a single-link regular file");
	}
}

function isPrivateFile(stats: BigIntStats): boolean {
	return stats.isFile() && stats.nlink === 1n;
}

/** Check every existing path component without following links. */
export function inspectWorkspaceEntry(path: string): BigIntStats | undefined {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	const components = absolute.slice(current.length).split(sep).filter(Boolean);
	let stats: BigIntStats | undefined;
	try {
		for (const [index, component] of components.entries()) {
			current = join(current, component);
			stats = lstatSync(current, { bigint: true });
			if (stats.isDirectory()) continue;
			if (!isPrivateFile(stats)) throw new UnsafeWorkspaceEntry();
			if (index < components.length - 1) return undefined;
		}
		return stats ?? lstatSync(current, { bigint: true });
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
}

/** Verify both the opened file and its identity in the checked workspace path. */
export function openWorkspaceFile(path: string): { fd: number; size: bigint } {
	if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new UnsafeWorkspaceEntry();
	const absolute = resolve(path);
	const expected = inspectWorkspaceEntry(absolute);
	if (!expected) throw Object.assign(new Error("workspace file does not exist"), { code: "ENOENT" });
	if (!isPrivateFile(expected)) throw new UnsafeWorkspaceEntry();
	const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd, { bigint: true });
		const current = inspectWorkspaceEntry(absolute);
		if (!isPrivateFile(opened) || opened.dev !== expected.dev || opened.ino !== expected.ino ||
			!current || current.dev !== opened.dev || current.ino !== opened.ino) {
			throw new UnsafeWorkspaceEntry();
		}
		return { fd, size: opened.size };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}
