import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GondolinSandbox, type GondolinTurn } from "../src/gondolin.js";
import { createBashTool } from "../src/tools/bash.js";
import { ensureChatDir, type ChatPaths } from "../src/workspace.js";

let workspace: string;
let chat: ChatPaths;
let turns: GondolinTurn[];

beforeEach(() => {
	workspace = mkdtempSync(join(realpathSync(tmpdir()), "pi-bot-gondolin-"));
	chat = ensureChatDir(workspace, "42");
	turns = [];
});

afterEach(async () => {
	await Promise.all(turns.map((turn) => turn.close()));
	rmSync(workspace, { force: true, recursive: true });
});

function openTurn(sandbox: GondolinSandbox, paths = chat): GondolinTurn {
	const turn = sandbox.turn(paths);
	turns.push(turn);
	return turn;
}

const vmTest = process.env.PI_BOT_TEST_GONDOLIN === "1" ? test : test.skip;

vmTest("reuses the guest per turn, persists only projected data, and does not expose another chat", async () => {
	const otherChat = ensureChatDir(workspace, "43");
	writeFileSync(join(chat.chatDir, "context.jsonl"), "host state");
	writeFileSync(join(chat.attachmentsDir, "input.txt"), "incoming");
	writeFileSync(join(workspace, "skills", "shared.txt"), "shared skill");
	writeFileSync(join(otherChat.scratchDir, "secret.txt"), "another chat");
	const sandbox = new GondolinSandbox(1);
	const turn = openTurn(sandbox);
	const before = await turn.exec("printf scratch > scratch/work.txt; printf turn > /tmp/turn; printf note > MEMORY.md; printf err >&2; exit 7");
	expect(before).toEqual({ stdout: "", stderr: "err", code: 7 });
	const visible = await turn.exec("cat /tmp/turn attachments/input.txt /workspace/skills/shared.txt");
	expect(visible.stdout).toBe("turnincomingshared skill");
	const denied = await turn.exec("test ! -e context.jsonl && test ! -e /workspace/43 && test ! -e /data/workspace/43 && ! touch attachments/no && ! rm MEMORY.md");
	expect(denied.code).toBe(0);
	expect(denied.stderr).toContain("attachments/no");
	expect(denied.stderr).toContain("MEMORY.md");
	expect(readFileSync(join(chat.scratchDir, "work.txt"), "utf8")).toBe("scratch");
	expect(readFileSync(chat.memoryFile, "utf8")).toBe("note");
	await turn.close();
	const next = openTurn(sandbox);
	expect(await next.exec("test ! -e /tmp/turn && cat scratch/work.txt MEMORY.md")).toEqual({ stdout: "scratchnote", stderr: "", code: 0 });
}, 30_000);

vmTest("releases its slot and terminates the VM on command timeout", async () => {
	const sandbox = new GondolinSandbox(1);
	const turn = openTurn(sandbox);
	await turn.exec("true");
	const waiting = openTurn(sandbox);
	const next = waiting.exec("echo next");
	await expect(turn.exec("sleep 30", { timeout: 0.05 })).rejects.toThrow("Command timed out");
	await expect(turn.exec("true")).rejects.toThrow("closed");
	await expect(next).resolves.toEqual({ stdout: "next\n", stderr: "", code: 0 });
}, 30_000);

vmTest("exports guest bytes from the current chat without opening host paths", async () => {
	const turn = openTurn(new GondolinSandbox(1));
	const otherChat = ensureChatDir(workspace, "43");
	const hostFile = join(otherChat.scratchDir, "file.txt");
	writeFileSync(hostFile, "another chat\n");
	await expect(turn.readAttachment(hostFile)).rejects.toThrow("this chat's scratch or attachments");
	await expect(turn.readAttachment("/workspace/43/scratch/file.txt")).rejects.toThrow("this chat's scratch or attachments");
	await expect(turn.readAttachment("/workspace/42/scratch/../../43/scratch/file.txt")).rejects.toThrow("this chat's scratch or attachments");
	expect((await turn.exec("printf report > scratch/file.txt")).code).toBe(0);
	await expect(turn.readAttachment("/workspace/42/scratch/file.txt")).resolves.toEqual(Buffer.from("report"));
	await expect(turn.readAttachment("/workspace/42/scratch/file.txt/..")).rejects.toThrow("this chat's scratch or attachments");
}, 30_000);

vmTest("keeps truncated bash output readable inside the live turn", async () => {
	const turn = openTurn(new GondolinSandbox(1));
	const tool = createBashTool(turn);
	const result = await tool.execute("long-output", { label: "Generate lines", command: "seq 10000" });
	const spill = result.details?.fullOutputPath;
	expect(spill).toMatch(/^\/tmp\/pi-bot-bash-/);
	expect(await turn.exec(`head -n 1 '${spill}'`)).toEqual({ stdout: "1\n", stderr: "", code: 0 });
}, 30_000);
