import { expect } from "bun:test";
import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VMSandbox } from "pi-bot-core/vm-sandbox";
import { createBashTool } from "../src/tools/bash.js";
import { createReadTool } from "../src/tools/read.js";
import { ensureChatDir } from "../src/workspace.js";
import { useVMSandboxFixture, vmTest } from "./helpers/vm-sandbox.js";

const fixture = useVMSandboxFixture();
const { openTurn } = fixture;

vmTest("reads one line of a large file without stopping the VM", async () => {
	writeFileSync(join(fixture.chat.scratchDir, "large.txt"), "first\n" + "x".repeat(11 * 1024 * 1024));
	const turn = openTurn(new VMSandbox(1));
	const result = await createReadTool(turn).execute("read", { label: "Read header", path: "scratch/large.txt", limit: 1 });
	expect(result.content).toEqual([{ type: "text", text: "first\n\n[1 more lines in file. Use offset=2 to continue]" }]);
	expect((await turn.exec("echo still-running")).stdout).toBe("still-running\n");
}, 30_000);

vmTest("exports guest bytes from the current chat without accepting host paths", async () => {
	const turn = openTurn(new VMSandbox(1));
	const otherChat = ensureChatDir(fixture.workspace, "43");
	const hostFile = join(otherChat.scratchDir, "file.txt");
	writeFileSync(hostFile, "another chat\n");
	await expect(turn.readAttachment(hostFile)).rejects.toThrow("this chat's scratch or attachments");
	await expect(turn.readAttachment("/workspace/43/scratch/file.txt")).rejects.toThrow("this chat's scratch or attachments");
	await expect(turn.readAttachment("/workspace/42/scratch/../../43/scratch/file.txt")).rejects.toThrow("this chat's scratch or attachments");
	expect((await turn.exec("printf report > scratch/file.txt")).code).toBe(0);
	await expect(turn.readAttachment("/workspace/42/scratch/file.txt")).resolves.toEqual(Buffer.from("report"));
	await expect(turn.readAttachment("/workspace/42/scratch/file.txt/..")).rejects.toThrow("this chat's scratch or attachments");
}, 30_000);

vmTest("exports from the mounted directory even if the caller updates its paths", async () => {
	const paths = { ...fixture.chat };
	const turn = openTurn(new VMSandbox(1), paths);
	expect((await turn.exec("printf mounted > scratch/file.txt")).code).toBe(0);
	const otherDir = join(fixture.workspace, "other-scratch");
	mkdirSync(otherDir);
	writeFileSync(join(otherDir, "file.txt"), "not mounted");
	paths.scratchDir = otherDir;
	await expect(turn.readAttachment("/workspace/42/scratch/file.txt")).resolves.toEqual(Buffer.from("mounted"));
}, 30_000);

vmTest("rejects attachments larger than 10 MiB without closing the turn", async () => {
	const file = join(fixture.chat.scratchDir, "limit.bin");
	writeFileSync(file, "fixture");
	truncateSync(file, 10 * 1024 * 1024);
	const turn = openTurn(new VMSandbox(1));
	const path = "/workspace/42/scratch/limit.bin";
	expect((await turn.readAttachment(path)).length).toBe(10 * 1024 * 1024);
	truncateSync(file, 10 * 1024 * 1024 + 1);
	await expect(turn.readAttachment(path)).rejects.toThrow("maximum file size is 10 MiB");
	expect(await turn.exec("true")).toEqual({ stdout: "", stderr: "", code: 0 });
}, 30_000);

vmTest("reports the workspace output limit when a command exceeds it", async () => {
	const turn = openTurn(new VMSandbox(1));
	// Boot separately so host load cannot turn the output-limit check into a command timeout.
	await turn.exec("true");
	await expect(createBashTool(turn).execute("output-limit", {
		label: "Generate oversized output", command: "head -c 10485761 /dev/zero",
	})).rejects.toThrow("Workspace tool output exceeded 10 MiB.");
}, 45_000);

vmTest("keeps truncated bash output readable inside the live turn", async () => {
	const turn = openTurn(new VMSandbox(1));
	const tool = createBashTool(turn);
	const result = await tool.execute("long-output", { label: "Generate lines", command: "seq 10000" });
	const spill = result.details?.fullOutputPath;
	expect(spill).toMatch(/^\/tmp\/pi-bot-bash-/);
	expect(await turn.exec(`head -n 1 '${spill}'`)).toEqual({ stdout: "1\n", stderr: "", code: 0 });
}, 30_000);
