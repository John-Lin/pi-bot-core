import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VM } from "@earendil-works/gondolin";
import { GONDOLIN_IMAGE, GondolinSandbox, type GondolinTurn } from "../src/gondolin.js";
import { createBashTool } from "../src/tools/bash.js";
import { createReadTool } from "../src/tools/read.js";
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

vmTest("allows a queued turn to time out without closing the active VM", async () => {
	const sandbox = new GondolinSandbox(1);
	const owner = openTurn(sandbox);
	await owner.exec("printf owner > /tmp/owner");
	const queued = openTurn(sandbox);
	await expect(queued.exec("true", { timeout: 0.05 })).rejects.toThrow("Command timed out");
	expect((await owner.exec("cat /tmp/owner")).stdout).toBe("owner");
	await owner.close();
	expect((await openTurn(sandbox).exec("echo next")).stdout).toBe("next\n");
}, 30_000);

vmTest("rejects queued and new turns when VM cleanup fails", async () => {
	const sandbox = new GondolinSandbox(1);
	const owner = sandbox.turn(chat);
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
		expect(outcome).toContain("Gondolin VM cleanup failed");
		await expect(openTurn(sandbox).exec("true", { timeout: 0.5 })).rejects.toThrow("Gondolin VM cleanup failed");
	} finally {
		fault.mockRestore();
	}
}, 30_000);

test("a turn with an empty image cache fails without contacting the registry", async () => {
	const response = Promise.withResolvers<Response>();
	let requests = 0;
	const registry = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return response.promise;
		},
	});
	const previousStore = process.env.GONDOLIN_IMAGE_STORE;
	const previousRegistry = process.env.GONDOLIN_IMAGE_REGISTRY_URL;
	process.env.GONDOLIN_IMAGE_STORE = join(workspace, "empty-image-store");
	process.env.GONDOLIN_IMAGE_REGISTRY_URL = new URL("registry.json", registry.url).href;
	const turn = openTurn(new GondolinSandbox(1));
	const result = turn.exec("true", { timeout: 0.1 }).catch((error: Error) => error.message);
	try {
		const outcome = await Promise.race([result, Bun.sleep(600).then(() => "turn is still waiting")]);
		expect(outcome).toContain(`Gondolin image ${GONDOLIN_IMAGE} is not available locally`);
		expect(requests).toBe(0);
	} finally {
		response.resolve(new Response("test teardown", { status: 503 }));
		await result;
		await registry.stop(true);
		if (previousStore === undefined) delete process.env.GONDOLIN_IMAGE_STORE;
		else process.env.GONDOLIN_IMAGE_STORE = previousStore;
		if (previousRegistry === undefined) delete process.env.GONDOLIN_IMAGE_REGISTRY_URL;
		else process.env.GONDOLIN_IMAGE_REGISTRY_URL = previousRegistry;
	}
});

vmTest("reads one line of a large file without stopping the VM", async () => {
	writeFileSync(join(chat.scratchDir, "large.txt"), "first\n" + "x".repeat(11 * 1024 * 1024));
	const turn = openTurn(new GondolinSandbox(1));
	const result = await createReadTool(turn).execute("read", { label: "Read header", path: "scratch/large.txt", limit: 1 });
	expect(result.content).toEqual([{ type: "text", text: "first\n\n[1 more lines in file. Use offset=2 to continue]" }]);
	expect((await turn.exec("echo still-running")).stdout).toBe("still-running\n");
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
