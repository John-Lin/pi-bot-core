import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import {
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	WorkspaceBootstrapSecurityError,
	ensureWorkspaceBootstrap,
	ensureWorkspacePathIsSafe,
	readWorkspaceBootstrap,
} from "pi-bot-core/workspace-bootstrap";

const BOOTSTRAP_FILES = [
	["AGENTS.md", "agents_md", "# Agent Instructions\n"],
	["SOUL.md", "soul_md", "# Persona\n"],
	["IDENTITY.md", "identity_md", "# Identity\n"],
	["USER.md", "user_md", "# User Preferences\n"],
] as const;

const NO_FOLLOW_UNSUPPORTED = "Cannot safely load workspace bootstrap files: fs.constants.O_NOFOLLOW is not supported on this platform.";
const LINKED_WORKSPACE = "Cannot safely use workspace: the path or one of its parents is a symbolic link.";

function makeTempWorkspace(prefix: string): string {
	return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}

function emptyPrompt(visibleWorkspace: string): string {
	return BOOTSTRAP_FILES.map(([name, tag]) => `### ${visibleWorkspace}/${name}\n<${tag}>\n\n</${tag}>`).join("\n\n");
}

function section(prompt: string, tag: string): string {
	const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
	if (!match) throw new Error(`Missing <${tag}> section`);
	return match[1]!;
}

function withNoFollow<T>(value: number | undefined, run: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(constants, "O_NOFOLLOW")!;
	try {
		Object.defineProperty(constants, "O_NOFOLLOW", { ...descriptor, value });
		return run();
	} finally {
		Object.defineProperty(constants, "O_NOFOLLOW", descriptor);
	}
}

/** Record real filesystem calls while still performing them. */
function recordFsOperations(methods: string[]): { operations: string[]; restore: () => void } {
	const operations: string[] = [];
	const spies = methods.map((method) => {
		const original = (fs as any)[method];
		return spyOn(fs as any, method).mockImplementation((...args: unknown[]) => {
			operations.push(method);
			return original(...args);
		});
	});
	return { operations, restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

describe("WorkspaceBootstrapSecurityError", () => {
	test("is a named Error with the unsupported O_NOFOLLOW message by default", () => {
		const error = new WorkspaceBootstrapSecurityError();
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("WorkspaceBootstrapSecurityError");
		expect(error.message).toBe(NO_FOLLOW_UNSUPPORTED);
		expect(new WorkspaceBootstrapSecurityError("custom").message).toBe("custom");
	});
});

describe("ensureWorkspacePathIsSafe", () => {
	test("creates a missing workspace under real directories and is idempotent", () => {
		const root = makeTempWorkspace("pi-bot-safe-path-");
		const workspace = join(root, "new", "workspace");
		try {
			ensureWorkspacePathIsSafe(workspace);
			expect(fs.lstatSync(workspace).isDirectory()).toBe(true);
			expect(readdirSync(workspace)).toEqual([]);

			ensureWorkspacePathIsSafe(workspace);
			expect(fs.lstatSync(workspace).isDirectory()).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	for (const component of ["root", "parent"] as const) {
		test(`rejects a linked workspace ${component} without writing through it`, () => {
			const root = makeTempWorkspace("pi-bot-safe-path-link-");
			const external = join(root, "external");
			const link = join(root, "link");
			try {
				mkdirSync(external);
				symlinkSync(external, link);
				const workspace = component === "root" ? link : join(link, "missing", "workspace");

				expect(() => ensureWorkspacePathIsSafe(workspace)).toThrow(WorkspaceBootstrapSecurityError);
				expect(() => ensureWorkspacePathIsSafe(workspace)).toThrow(LINKED_WORKSPACE);
				expect(readdirSync(external)).toEqual([]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		test(`rejects a non-directory workspace ${component} without changing it`, () => {
			const root = makeTempWorkspace("pi-bot-safe-path-file-");
			const file = join(root, "file");
			try {
				writeFileSync(file, "unchanged");
				const workspace = component === "root" ? file : join(file, "workspace");

				expect(() => ensureWorkspacePathIsSafe(workspace)).toThrow(WorkspaceBootstrapSecurityError);
				expect(readFileSync(file, "utf8")).toBe("unchanged");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	for (const unsupported of [undefined, 0]) {
		test(`rejects O_NOFOLLOW=${unsupported} before any workspace I/O`, () => {
			const root = makeTempWorkspace("pi-bot-safe-path-no-follow-");
			const workspace = join(root, "missing", "workspace");
			const recorder = recordFsOperations(["existsSync", "lstatSync", "mkdirSync", "openSync", "readFileSync", "writeFileSync"]);
			try {
				withNoFollow(unsupported, () => {
					expect(() => ensureWorkspacePathIsSafe(workspace)).toThrow(WorkspaceBootstrapSecurityError);
					expect(() => ensureWorkspacePathIsSafe(workspace)).toThrow(NO_FOLLOW_UNSUPPORTED);
				});
				expect(recorder.operations).toEqual([]);
			} finally {
				recorder.restore();
			}
			try {
				expect(existsSync(join(root, "missing"))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});

describe("ensureWorkspaceBootstrap", () => {
	test("seeds shared bootstrap starters at the workspace root", () => {
		const workspace = makeTempWorkspace("pi-bot-bootstrap-seed-");
		try {
			ensureWorkspaceBootstrap(workspace);

			for (const [name, , starter] of BOOTSTRAP_FILES) {
				expect(readFileSync(join(workspace, name), "utf8")).toBe(starter);
			}
			expect(readdirSync(workspace).sort()).toEqual(["AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md"]);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("does not replace existing instructions across repeated calls", () => {
		const workspace = makeTempWorkspace("pi-bot-bootstrap-no-overwrite-");
		try {
			writeFileSync(join(workspace, "SOUL.md"), "My custom voice");
			writeFileSync(join(workspace, "USER.md"), "");

			ensureWorkspaceBootstrap(workspace);
			writeFileSync(join(workspace, "AGENTS.md"), "Edited after seeding");
			ensureWorkspaceBootstrap(workspace);

			expect(readFileSync(join(workspace, "SOUL.md"), "utf8")).toBe("My custom voice");
			expect(readFileSync(join(workspace, "USER.md"), "utf8")).toBe("");
			expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe("Edited after seeding");
			expect(readFileSync(join(workspace, "IDENTITY.md"), "utf8")).toBe("# Identity\n");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("does not create a file through a dangling bootstrap file link", () => {
		const root = makeTempWorkspace("pi-bot-bootstrap-dangling-");
		const workspace = join(root, "workspace");
		const target = join(root, "external-user.md");
		try {
			mkdirSync(workspace);
			symlinkSync(target, join(workspace, "USER.md"));

			ensureWorkspaceBootstrap(workspace);

			expect(existsSync(target)).toBe(false);
			expect(fs.lstatSync(join(workspace, "USER.md")).isSymbolicLink()).toBe(true);
			expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe("# Agent Instructions\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not create a missing workspace", () => {
		const root = makeTempWorkspace("pi-bot-bootstrap-missing-");
		const workspace = join(root, "missing", "workspace");
		try {
			ensureWorkspaceBootstrap(workspace);
			expect(existsSync(join(root, "missing"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	for (const component of ["root", "parent"] as const) {
		test(`does not create bootstrap files through a symlinked workspace ${component}`, () => {
			const root = makeTempWorkspace("pi-bot-bootstrap-seed-link-");
			const external = join(root, "external");
			const link = join(root, "link");
			try {
				mkdirSync(join(external, "workspace"), { recursive: true });
				symlinkSync(external, link);
				const workspace = component === "root" ? link : join(link, "workspace");

				ensureWorkspaceBootstrap(workspace);

				expect(readdirSync(external)).toEqual(["workspace"]);
				expect(readdirSync(join(external, "workspace"))).toEqual([]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	test("stops seeding when the workspace is replaced between files", () => {
		const root = makeTempWorkspace("pi-bot-bootstrap-seed-swap-");
		const workspace = join(root, "workspace");
		const originalWorkspace = join(root, "original-workspace");
		const externalWorkspace = join(root, "external-workspace");
		mkdirSync(workspace);
		mkdirSync(externalWorkspace);
		const originalWrite = fs.writeFileSync.bind(fs);
		let substituted = false;
		// Perform the real write, then swap the workspace for a link before the next file.
		const write = spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
			originalWrite(...args);
			if (!substituted && args[0] === join(workspace, "AGENTS.md")) {
				substituted = true;
				renameSync(workspace, originalWorkspace);
				symlinkSync(externalWorkspace, workspace);
			}
		}) as typeof fs.writeFileSync);
		try {
			ensureWorkspaceBootstrap(workspace);

			expect(substituted).toBe(true);
			expect(readdirSync(externalWorkspace)).toEqual([]);
			expect(readdirSync(originalWorkspace)).toEqual(["AGENTS.md"]);
		} finally {
			write.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("readWorkspaceBootstrap", () => {
	test("renders seeded starters as tagged sections under the visible workspace path", () => {
		const workspace = makeTempWorkspace("pi-bot-bootstrap-read-");
		try {
			ensureWorkspaceBootstrap(workspace);

			expect(readWorkspaceBootstrap(workspace, "/workspace")).toBe(
				"### /workspace/AGENTS.md\n<agents_md>\n# Agent Instructions\n</agents_md>\n\n" +
				"### /workspace/SOUL.md\n<soul_md>\n# Persona\n</soul_md>\n\n" +
				"### /workspace/IDENTITY.md\n<identity_md>\n# Identity\n</identity_md>\n\n" +
				"### /workspace/USER.md\n<user_md>\n# User Preferences\n</user_md>",
			);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("trims content and does not expose the host workspace path", () => {
		const workspace = makeTempWorkspace("pi-bot-bootstrap-trim-");
		try {
			writeFileSync(join(workspace, "IDENTITY.md"), "\n  Name: Finch  \n\n");

			const prompt = readWorkspaceBootstrap(workspace, "/visible");
			expect(section(prompt, "identity_md")).toBe("Name: Finch");
			expect(prompt).toContain("### /visible/IDENTITY.md");
			expect(prompt).not.toContain(workspace);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("renders empty sections for missing files and a missing workspace without creating them", () => {
		const root = makeTempWorkspace("pi-bot-bootstrap-read-missing-");
		const workspace = join(root, "workspace");
		try {
			expect(readWorkspaceBootstrap(workspace, "/workspace")).toBe(emptyPrompt("/workspace"));
			expect(existsSync(workspace)).toBe(false);

			mkdirSync(workspace);
			expect(readWorkspaceBootstrap(workspace, "/workspace")).toBe(emptyPrompt("/workspace"));
			expect(readdirSync(workspace)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rereads shared USER.md preferences on every call", () => {
		const workspace = makeTempWorkspace("pi-bot-bootstrap-reread-");
		try {
			writeFileSync(join(workspace, "AGENTS.md"), "Handle with care");
			writeFileSync(join(workspace, "SOUL.md"), "Speak gently");
			writeFileSync(join(workspace, "IDENTITY.md"), "Name: Finch");
			writeFileSync(join(workspace, "USER.md"), "Prefer concise answers");
			const first = readWorkspaceBootstrap(workspace, "/workspace");
			expect(section(first, "agents_md")).toBe("Handle with care");
			expect(section(first, "soul_md")).toBe("Speak gently");
			expect(section(first, "identity_md")).toBe("Name: Finch");
			expect(section(first, "user_md")).toBe("Prefer concise answers");

			writeFileSync(join(workspace, "USER.md"), "Prefer detailed answers");
			const second = readWorkspaceBootstrap(workspace, "/workspace");
			expect(section(second, "user_md")).toBe("Prefer detailed answers");
			expect(second).not.toContain("Prefer concise answers");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("ignores non-regular bootstrap entries without blocking", () => {
		const workspace = makeTempWorkspace("pi-bot-bootstrap-non-regular-");
		try {
			mkdirSync(join(workspace, "AGENTS.md"));
			const mkfifo = Bun.spawnSync(["mkfifo", join(workspace, "SOUL.md")]);
			expect(mkfifo.exitCode).toBe(0);
			expect(mkfifo.stderr.toString()).toBe("");

			expect(readWorkspaceBootstrap(workspace, "/workspace")).toBe(emptyPrompt("/workspace"));
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("does not read bootstrap files through a workspace symlink", () => {
		const root = makeTempWorkspace("pi-bot-workspace-link-");
		const externalWorkspace = join(root, "external");
		const workspaceLink = join(root, "workspace");
		try {
			mkdirSync(externalWorkspace);
			writeFileSync(join(externalWorkspace, "AGENTS.md"), "private external value");
			symlinkSync(externalWorkspace, workspaceLink);

			expect(readWorkspaceBootstrap(workspaceLink, "/workspace")).toBe(emptyPrompt("/workspace"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not read bootstrap files through a symlinked workspace parent", () => {
		const root = makeTempWorkspace("pi-bot-parent-link-");
		const externalParent = join(root, "external-parent");
		const linkedParent = join(root, "linked-parent");
		const workspace = join(linkedParent, "workspace");
		try {
			mkdirSync(join(externalParent, "workspace"), { recursive: true });
			writeFileSync(join(externalParent, "workspace", "AGENTS.md"), "private external value");
			symlinkSync(externalParent, linkedParent);

			expect(readWorkspaceBootstrap(workspace, "/workspace")).toBe(emptyPrompt("/workspace"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not inject external content when the workspace is replaced during open", () => {
		const root = makeTempWorkspace("pi-bot-workspace-swap-");
		const workspace = join(root, "workspace");
		const originalWorkspace = join(root, "original-workspace");
		const externalWorkspace = join(root, "external-workspace");
		mkdirSync(workspace);
		mkdirSync(externalWorkspace);
		writeFileSync(join(workspace, "AGENTS.md"), "trusted value");
		writeFileSync(join(externalWorkspace, "AGENTS.md"), "private external value");
		const originalOpen = fs.openSync.bind(fs);
		let substituted = false;
		const open = spyOn(fs, "openSync").mockImplementation(((openedPath: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
			if (!substituted && openedPath === join(workspace, "AGENTS.md")) {
				substituted = true;
				renameSync(workspace, originalWorkspace);
				symlinkSync(externalWorkspace, workspace);
			}
			return originalOpen(openedPath, flags, mode);
		}) as typeof fs.openSync);
		try {
			const prompt = readWorkspaceBootstrap(workspace, "/workspace");
			expect(substituted).toBe(true);
			expect(prompt).not.toContain("private external value");
			expect(prompt).toBe(emptyPrompt("/workspace"));
		} finally {
			open.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not read a link substituted after checking a regular file", () => {
		const workspace = makeTempWorkspace("pi-bot-identity-");
		const path = join(workspace, "SOUL.md");
		const secret = join(workspace, "..", `${workspace.split("/").at(-1)}-secret`);
		writeFileSync(path, "regular file");
		writeFileSync(secret, "private host value");
		const substituteLink = () => {
			rmSync(path);
			symlinkSync(secret, path);
		};
		const originalStat = fs.lstatSync.bind(fs);
		const originalOpen = fs.openSync.bind(fs);
		const stat = spyOn(fs, "lstatSync").mockImplementation(((checkedPath: fs.PathLike, options?: fs.StatOptions) => {
			const result = originalStat(checkedPath, options);
			if (checkedPath === path) substituteLink();
			return result;
		}) as typeof fs.lstatSync);
		const open = spyOn(fs, "openSync").mockImplementation(((openedPath: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
			if (openedPath === path) substituteLink();
			return originalOpen(openedPath, flags, mode);
		}) as typeof fs.openSync);
		try {
			const prompt = readWorkspaceBootstrap(workspace, "/workspace");
			expect(prompt).not.toContain("private host value");
			expect(section(prompt, "soul_md")).toBe("");
			expect(originalStat(path).isSymbolicLink()).toBe(true);
		} finally {
			stat.mockRestore();
			open.mockRestore();
			rmSync(workspace, { recursive: true, force: true });
			rmSync(secret, { force: true });
		}
	});

	test("does not follow links to files outside the workspace", () => {
		const workspace = makeTempWorkspace("pi-bot-identity-");
		const secret = join(workspace, "..", `${workspace.split("/").at(-1)}-secret`);
		try {
			writeFileSync(secret, "private host value");
			symlinkSync(secret, join(workspace, "SOUL.md"));
			writeFileSync(join(workspace, "AGENTS.md"), "trusted value");

			const prompt = readWorkspaceBootstrap(workspace, "/workspace");
			expect(prompt).not.toContain("private host value");
			expect(section(prompt, "soul_md")).toBe("");
			expect(section(prompt, "agents_md")).toBe("trusted value");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(secret, { force: true });
		}
	});

	for (const unsupported of [undefined, 0]) {
		test(`fails safely when the runtime provides O_NOFOLLOW=${unsupported}`, () => {
			const workspace = makeTempWorkspace("pi-bot-no-nofollow-");
			try {
				writeFileSync(join(workspace, "AGENTS.md"), "must not be read insecurely");
				withNoFollow(unsupported, () => {
					expect(() => readWorkspaceBootstrap(workspace, "/workspace")).toThrow(WorkspaceBootstrapSecurityError);
					expect(() => readWorkspaceBootstrap(workspace, "/workspace")).toThrow(NO_FOLLOW_UNSUPPORTED);
				});
			} finally {
				rmSync(workspace, { recursive: true, force: true });
			}
		});
	}

	test("keeps files at the character limits without a truncation marker", () => {
		const workspace = makeTempWorkspace("pi-bot-bootstrap-limit-");
		try {
			writeFileSync(join(workspace, "AGENTS.md"), "A".repeat(20_000));
			writeFileSync(join(workspace, "USER.md"), "😀".repeat(4_000));

			const prompt = readWorkspaceBootstrap(workspace, "/workspace");
			expect(section(prompt, "agents_md")).toBe("A".repeat(20_000));
			expect(section(prompt, "user_md")).toBe("😀".repeat(4_000));
			expect(prompt).not.toContain("truncated");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("bounds large workspace files so they do not exhaust the system prompt", () => {
		const workspace = makeTempWorkspace("pi-bot-identity-");
		try {
			writeFileSync(join(workspace, "AGENTS.md"), `${"A".repeat(20_000)}DO_NOT_INJECT`);
			const prompt = readWorkspaceBootstrap(workspace, "/workspace");
			expect(section(prompt, "agents_md")).toBe(
				`${"A".repeat(20_000)}\n[truncated: read /workspace/AGENTS.md for the rest]`,
			);
			expect(prompt).not.toContain("DO_NOT_INJECT");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("counts non-BMP Unicode as characters when truncating", () => {
		const workspace = makeTempWorkspace("pi-bot-unicode-");
		try {
			writeFileSync(join(workspace, "AGENTS.md"), `${"😀".repeat(20_001)}DO_NOT_INJECT`);
			const prompt = readWorkspaceBootstrap(workspace, "/workspace");
			expect(prompt).toContain("😀".repeat(20_000));
			expect(prompt).not.toContain("😀".repeat(20_001));
			expect(prompt).not.toContain("DO_NOT_INJECT");
			expect(prompt).toContain("truncated: read /workspace/AGENTS.md");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("does not emit invalid Unicode when the byte limit splits a code point", () => {
		const workspace = makeTempWorkspace("pi-bot-unicode-boundary-");
		try {
			writeFileSync(join(workspace, "AGENTS.md"), ` ${"😀".repeat(20_000)}X`);
			const prompt = readWorkspaceBootstrap(workspace, "/workspace");
			expect(prompt).not.toContain("�");
			expect(prompt).toContain("😀".repeat(19_999));
			expect(prompt).not.toContain("X");
			expect(prompt).toContain("truncated");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("bounds reads of oversized sparse bootstrap files", () => {
		const workspace = makeTempWorkspace("pi-bot-sparse-");
		try {
			const path = join(workspace, "AGENTS.md");
			writeFileSync(path, "safe prefix");
			truncateSync(path, 3 * 1024 ** 3);

			const prompt = readWorkspaceBootstrap(workspace, "/workspace");
			expect(prompt).toContain("safe prefix");
			expect(prompt).toContain("truncated: read /workspace/AGENTS.md");
			expect(prompt.length).toBeLessThan(100_000);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("keeps shared USER.md preferences within the smaller user-model prompt budget", () => {
		const workspace = makeTempWorkspace("pi-bot-user-");
		try {
			writeFileSync(join(workspace, "USER.md"), `${"P".repeat(4_000)}DO_NOT_INJECT`);
			const prompt = readWorkspaceBootstrap(workspace, "/workspace");
			expect(prompt).toContain("### /workspace/USER.md");
			expect(section(prompt, "user_md")).toBe(
				`${"P".repeat(4_000)}\n[truncated: read /workspace/USER.md for the rest]`,
			);
			expect(prompt).not.toContain("DO_NOT_INJECT");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
