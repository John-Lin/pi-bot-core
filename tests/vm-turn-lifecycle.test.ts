import { expect, spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VM } from "@earendil-works/gondolin";
import { VMSandbox, type VMSandboxTurn } from "pi-bot-core/vm-sandbox";
import { ensureChatDir } from "../src/workspace.js";
import { useVMSandboxFixture, vmTest, workspaceSecrets } from "./helpers/vm-sandbox.js";

const fixture = useVMSandboxFixture();
const { openTurn } = fixture;

vmTest("injects only configured secret placeholders and regenerates them per turn", async () => {
	const sandbox = new VMSandbox(1, { secrets: {
		...workspaceSecrets,
		UNSET_SECRET: { value: " \t", hosts: ["api.example.com"] },
	} });
	const readPlaceholders = async (turn: VMSandboxTurn) => {
		const result = await turn.exec('test -z "${UNSET_SECRET+x}" && printf "%s\\n%s\\n" "$GEMINI_API_KEY" "$GH_TOKEN"');
		expect(result.code, result.stderr).toBe(0);
		const placeholders = result.stdout.trim().split("\n");
		expect(placeholders).toHaveLength(2);
		expect(new Set(placeholders).size).toBe(2);
		for (const placeholder of placeholders) {
			expect(placeholder).not.toBe("");
			for (const { value } of Object.values(workspaceSecrets)) expect(placeholder).not.toContain(value);
		}
		return placeholders;
	};
	const first = openTurn(sandbox);
	const original = await readPlaceholders(first);
	expect(await readPlaceholders(first)).toEqual(original);
	await first.close();
	const next = await readPlaceholders(openTurn(sandbox));
	expect(next.every((placeholder) => !original.includes(placeholder))).toBe(true);
}, 30_000);

vmTest("reuses the guest per turn, persists only projected data, and does not expose another chat", async () => {
	const otherChat = ensureChatDir(fixture.workspace, "43");
	writeFileSync(join(fixture.chat.chatDir, "context.jsonl"), "host state");
	writeFileSync(join(fixture.chat.attachmentsDir, "input.txt"), "incoming");
	writeFileSync(join(fixture.workspace, "skills", "shared.txt"), "shared skill");
	writeFileSync(join(otherChat.scratchDir, "secret.txt"), "another chat");
	const sandbox = new VMSandbox(1);
	const turn = openTurn(sandbox);
	const before = await turn.exec("printf scratch > scratch/work.txt; printf turn > /tmp/turn; printf note > MEMORY.md; printf err >&2; exit 7");
	expect(before).toEqual({ stdout: "", stderr: "err", code: 7 });
	const visible = await turn.exec("cat /tmp/turn attachments/input.txt /workspace/skills/shared.txt");
	expect(visible.stdout).toBe("turnincomingshared skill");
	const denied = await turn.exec("test ! -e context.jsonl && test ! -e /workspace/43 && test ! -e /data/workspace/43 && ! touch attachments/no && ! rm MEMORY.md");
	expect(denied.code).toBe(0);
	expect(denied.stderr).toContain("attachments/no");
	expect(denied.stderr).toContain("MEMORY.md");
	expect(readFileSync(join(fixture.chat.scratchDir, "work.txt"), "utf8")).toBe("scratch");
	expect(readFileSync(fixture.chat.memoryFile, "utf8")).toBe("note");
	await turn.close();
	const next = openTurn(sandbox);
	expect(await next.exec("test ! -e /tmp/turn && cat scratch/work.txt MEMORY.md")).toEqual({ stdout: "scratchnote", stderr: "", code: 0 });
}, 30_000);

vmTest("releases its slot and terminates the VM on command timeout", async () => {
	const sandbox = new VMSandbox(1);
	const turn = openTurn(sandbox);
	await turn.exec("true");
	const waiting = openTurn(sandbox);
	const next = waiting.exec("echo next");
	await expect(turn.exec("sleep 30", { timeout: 0.05 })).rejects.toThrow("Command timed out");
	await expect(turn.exec("true")).rejects.toThrow("closed");
	await expect(next).resolves.toEqual({ stdout: "next\n", stderr: "", code: 0 });
}, 30_000);

vmTest("allows a queued turn to time out without closing the active VM", async () => {
	const sandbox = new VMSandbox(1);
	const owner = openTurn(sandbox);
	await owner.exec("printf owner > /tmp/owner");
	const queued = openTurn(sandbox);
	await expect(queued.exec("true", { timeout: 0.05 })).rejects.toThrow("Command timed out");
	expect((await owner.exec("cat /tmp/owner")).stdout).toBe("owner");
	await owner.close();
	expect((await openTurn(sandbox).exec("echo next")).stdout).toBe("next\n");
}, 30_000);

vmTest("rejects queued and new turns when VM cleanup fails", async () => {
	const sandbox = new VMSandbox(1);
	const owner = sandbox.turn(fixture.chat);
	await owner.exec("true");
	const close = VM.prototype.close;
	const fault = spyOn(VM.prototype, "close").mockImplementationOnce(async function (this: VM) {
		await close.call(this);
		throw new Error("injected SDK cleanup error");
	});
	try {
		const waiting = openTurn(sandbox).exec("true").catch((error: Error) => error.message);
		await expect(owner.close()).rejects.toThrow("injected SDK cleanup error");
		const outcome = await Promise.race([waiting, Bun.sleep(600).then(() => "turn is still waiting")]);
		const message = "Workspace VM cleanup failed; the bot must be restarted before starting another turn.";
		expect(outcome).toBe(message);
		await expect(openTurn(sandbox).exec("true", { timeout: 0.5 })).rejects.toThrow(message);
	} finally {
		fault.mockRestore();
	}
}, 30_000);
