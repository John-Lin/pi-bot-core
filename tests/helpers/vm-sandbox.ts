import { afterEach, beforeEach, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VMSandbox, VMSandboxTurn } from "pi-bot-core/vm-sandbox";
import { ensureChatDir, type ChatPaths } from "../../src/workspace.js";

/** Runs only when the QEMU VM suite is enabled. */
export const vmTest = process.env.PI_BOT_TEST_VM_SANDBOX === "1" ? test : test.skip;
/** Runs only when the public HTTPS test is enabled. */
export const webTest = process.env.PI_BOT_TEST_VM_SANDBOX_WEB === "1" ? test : test.skip;
/** Runs only when the krun VM suite is enabled. */
export const krunTest = process.env.PI_BOT_TEST_VM_SANDBOX_KRUN === "1" ? test : test.skip;

export const workspaceSecrets = {
	GEMINI_API_KEY: { value: "fixture-gemini-not-a-real-key", hosts: ["generativelanguage.googleapis.com"] },
	GH_TOKEN: { value: "fixture-github-not-a-real-pat", hosts: ["api.github.com"] },
};

export interface VMSandboxFixture {
	/** The temporary workspace of the current test. */
	readonly workspace: string;
	/** Chat "42" in the current test's workspace. */
	readonly chat: ChatPaths;
	/** Opens a turn that is closed after the current test. */
	openTurn(sandbox: VMSandbox, paths?: ChatPaths): VMSandboxTurn;
	/** Runs a Bun script that can use only the given host commands, with the VM sandbox exports in scope. */
	runWithVmCommands(commands: string[], script: string, env: Record<string, string>): Bun.ReadableSyncSubprocess;
}

/**
 * Gives each test in the calling file a fresh workspace and chat and closes every turn it opened.
 * Call once at the top level of a test file; the hooks apply to that file only.
 */
export function useVMSandboxFixture(): VMSandboxFixture {
	let workspace: string;
	let chat: ChatPaths;
	let turns: VMSandboxTurn[];

	beforeEach(() => {
		workspace = mkdtempSync(join(realpathSync(tmpdir()), "pi-bot-vm-sandbox-"));
		chat = ensureChatDir(workspace, "42");
		turns = [];
	});

	afterEach(async () => {
		await Promise.all(turns.map((turn) => turn.close()));
		rmSync(workspace, { force: true, recursive: true });
	});

	function openTurn(sandbox: VMSandbox, paths = chat): VMSandboxTurn {
		const turn = sandbox.turn(paths);
		turns.push(turn);
		return turn;
	}

	function runWithVmCommands(commands: string[], script: string, env: Record<string, string>) {
		const bin = join(workspace, "bin");
		mkdirSync(bin);
		for (const command of commands) {
			const path = Bun.which(command);
			if (!path) throw new Error(`VM sandbox tests require ${command}`);
			symlinkSync(path, join(bin, command));
		}
		return Bun.spawnSync([process.execPath, "--no-env-file", "-e", `
			import { VM_SANDBOX_IMAGE, VMSandbox, VMSandboxTurn, validateVMSandbox } from ${JSON.stringify(import.meta.resolve("pi-bot-core/vm-sandbox"))};
			${script}
		`], { env: { ...process.env, ...env, PATH: bin }, timeout: 30_000 });
	}

	return {
		get workspace() {
			return workspace;
		},
		get chat() {
			return chat;
		},
		openTurn,
		runWithVmCommands,
	};
}
