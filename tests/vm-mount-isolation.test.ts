import { expect } from "bun:test";
import { linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VMSandbox } from "pi-bot-core/vm-sandbox";
import { ensureChatDir, loadChatSkills } from "../src/workspace.js";
import { krunTest, useVMSandboxFixture, vmTest } from "./helpers/vm-sandbox.js";

const fixture = useVMSandboxFixture();
const { openTurn, runWithVmCommands } = fixture;

vmTest("persists edits to the original attachment and reloads local and shared skills", async () => {
	const otherChat = ensureChatDir(fixture.workspace, "43");
	const attachment = join(fixture.chat.attachmentsDir, "input.txt");
	writeFileSync(attachment, "original");
	writeFileSync(join(otherChat.attachmentsDir, "input.txt"), "private");
	const sandbox = new VMSandbox(1, { writableWorkspaceContent: true });
	const turn = openTurn(sandbox);
	expect(loadChatSkills(fixture.chat)).toEqual([]);
	const edits = await turn.exec([
		"printf edited > attachments/input.txt",
		"printf '%s\\n' --- 'name: example' 'description: For every chat' --- > /workspace/skills/example.md",
		"printf '%s\\n' --- 'name: example' 'description: For this chat' --- > skills/example.md",
		"test ! -e /workspace/43 && test ! -e /data/workspace/43",
	].join(" && "));
	expect(edits).toEqual({ stdout: "", stderr: "", code: 0 });
	expect(await turn.readAttachment("/workspace/42/attachments/input.txt")).toEqual(Buffer.from("edited"));
	await turn.close();

	expect(readFileSync(attachment, "utf8")).toBe("edited");
	expect(loadChatSkills(fixture.chat).map(({ description }) => description)).toEqual(["For this chat"]);
	expect(loadChatSkills(otherChat).map(({ description }) => description)).toEqual(["For every chat"]);
	const otherTurn = openTurn(sandbox, otherChat);
	expect(await otherTurn.exec("printf '%s\\n' --- 'name: example' 'description: Updated by another chat' --- > /workspace/skills/.example.tmp && mv /workspace/skills/.example.tmp /workspace/skills/example.md && cat attachments/input.txt")).toEqual({
		stdout: "private", stderr: "", code: 0,
	});
	await otherTurn.close();
	const next = openTurn(sandbox);
	expect(await next.exec("cat attachments/input.txt && test -f skills/example.md")).toEqual({ stdout: "edited", stderr: "", code: 0 });
	expect(loadChatSkills(otherChat).map(({ description }) => description)).toEqual(["Updated by another chat"]);
}, 30_000);

vmTest("does not let writable mounts plant host-visible filesystem links", async () => {
	const turn = openTurn(new VMSandbox(1, { writableWorkspaceContent: true }));
	for (const mount of ["scratch", "attachments", "skills", "/workspace/skills"]) {
		const setup = await turn.exec(`touch ${mount}/target`);
		expect(setup).toEqual({ stdout: "", stderr: "", code: 0 });
		const symbolic = await turn.exec(`ln -s target ${mount}/symbolic`);
		expect(symbolic.code, JSON.stringify(symbolic)).not.toBe(0);
		expect(symbolic.stderr).toContain("symbolic");
		const hard = await turn.exec(`ln ${mount}/target ${mount}/hard`);
		expect(hard.code, JSON.stringify(hard)).not.toBe(0);
		expect(hard.stderr).toContain("hard");
		expect(await turn.exec(`test ! -L ${mount}/symbolic && test ! -e ${mount}/hard`)).toEqual({ stdout: "", stderr: "", code: 0 });
	}
}, 30_000);

vmTest("preserves mounted directories and their modes while allowing changes inside them", async () => {
	const turn = openTurn(new VMSandbox(1, { writableWorkspaceContent: true }));
	const mounts = [
		["/data/workspace/42/scratch", fixture.chat.scratchDir],
		["/data/workspace/42/attachments", fixture.chat.attachmentsDir],
		["/data/workspace/42/skills", fixture.chat.skillsDir],
		["/data/workspace/skills", join(fixture.workspace, "skills")],
	] as const;
	for (const [guest, host] of mounts) {
		const mode = statSync(host).mode;
		const differentMode = (mode & 0o777) === 0o700 ? "750" : "700";
		const chmod = await turn.exec(`chmod ${differentMode} ${guest}`);
		const rmdir = await turn.exec(`rmdir ${guest}`);
		// Some mount points are protected by the guest kernel before reaching the provider.
		expect(chmod.stdout).toBe("");
		if (chmod.code === 0) expect(chmod.stderr).toBe("");
		else expect(chmod.stderr).toContain("Permission denied");
		expect(rmdir.code, guest).toBe(1);
		expect(rmdir.stderr).toMatch(/Permission denied|Resource busy/);
		expect(statSync(host).mode).toBe(mode);
		expect(await turn.exec(`mkdir ${guest}/child && chmod 700 ${guest}/child && rmdir ${guest}/child`)).toEqual({
			stdout: "", stderr: "", code: 0,
		});
	}
}, 30_000);

vmTest("checks entries against the original relative mount after a host cwd change", () => {
	const otherCwd = join(fixture.workspace, "other-cwd");
	mkdirSync(otherCwd);
	const file = join(fixture.chat.scratchDir, "original.txt");
	writeFileSync(file, "fixture");
	linkSync(file, join(fixture.chat.scratchDir, "linked.txt"));
	const emulator = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
	const result = runWithVmCommands(["qemu-img", emulator], `
		import assert from "node:assert/strict";
		import { relative } from "node:path";
		process.chdir(${JSON.stringify(fixture.workspace)});
		const paths = Object.fromEntries(Object.entries(${JSON.stringify(fixture.chat)})
			.map(([key, path]) => [key, relative(process.cwd(), path) || "."]));
		const turn = new VMSandbox(1).turn(paths);
		try {
			assert.equal((await turn.exec("true")).code, 0);
			process.chdir(${JSON.stringify(otherCwd)});
			const result = await turn.exec("cat scratch/linked.txt", { timeout: 5 });
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /Permission denied/);
			assert.notEqual(result.code, 0);
		} finally {
			await turn.close();
		}
	`, {});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	expect(result.stderr.toString()).toBe("");
}, 35_000);

for (const backend of ["qemu", "krun"] as const) {
	const sandboxTest = backend === "qemu" ? vmTest : krunTest;
	sandboxTest(`rejects existing unsafe entries in ${backend} workspace mounts and attachment exports`, async () => {
		for (const dir of [fixture.chat.scratchDir, fixture.chat.attachmentsDir]) {
			writeFileSync(join(dir, "original.txt"), "fixture");
			linkSync(join(dir, "original.txt"), join(dir, "hard.txt"));
			mkdirSync(join(dir, "nested"));
			writeFileSync(join(dir, "nested", "normal.txt"), "report");
			symlinkSync("nested", join(dir, "symbolic"));
			const fifo = Bun.spawnSync(["mkfifo", join(dir, "pipe")]);
			expect({ code: fifo.exitCode, stderr: fifo.stderr.toString() }).toEqual({ code: 0, stderr: "" });
		}
		const turn = openTurn(new VMSandbox(1, { backend }));
		// Bound file access independently of guest boot, which can be slower under QEMU TCG.
		expect((await turn.exec("true")).code).toBe(0);
		for (const mount of ["scratch", "attachments"]) {
			for (const entry of ["hard.txt", "symbolic/normal.txt", "pipe"]) {
				const result = await turn.exec(`cat ${mount}/${entry}`, { timeout: 5 });
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("Permission denied");
				expect(result.code).not.toBe(0);
				await expect(turn.readAttachment(`/workspace/42/${mount}/${entry}`)).rejects.toThrow("unsafe workspace entry");
			}
			await expect(turn.readAttachment(`/workspace/42/${mount}/nested/normal.txt`)).resolves.toEqual(Buffer.from("report"));
		}
	}, 30_000);
}
