import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VM } from "@earendil-works/gondolin";
import { VMSandbox, validateVMSandbox, type VMSandboxTurn } from "pi-bot-core/vm-sandbox";
import { SandboxConfigError } from "../src/sandbox.js";
import { createBashTool } from "../src/tools/bash.js";
import { createReadTool } from "../src/tools/read.js";
import { ensureChatDir, loadChatSkills, type ChatPaths } from "../src/workspace.js";

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

const vmTest = process.env.PI_BOT_TEST_VM_SANDBOX === "1" ? test : test.skip;
const webTest = process.env.PI_BOT_TEST_VM_SANDBOX_WEB === "1" ? test : test.skip;
const krunTest = process.env.PI_BOT_TEST_VM_SANDBOX_KRUN === "1" ? test : test.skip;

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

function expectSandboxToRun(commands: string[], config: object | undefined, env: Record<string, string>): void {
	const result = runWithVmCommands(commands, `
		const config = ${JSON.stringify(config)};
		await validateVMSandbox(config);
		const paths = ${JSON.stringify(chat)};
		const turn = config === undefined
			? new VMSandboxTurn(paths, async () => () => {})
			: new VMSandbox(1, config).turn(paths);
		try {
			process.stdout.write(JSON.stringify(await turn.exec("uname -s", { timeout: 20 })));
		} finally {
			await turn.close();
		}
	`, env);
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	expect(result.stderr.toString()).toBe("");
	expect(JSON.parse(result.stdout.toString())).toEqual({ stdout: "Linux\n", stderr: "", code: 0 });
}

function expectQemuDefault(config?: object): void {
	const emulator = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
	expectSandboxToRun(["qemu-img", emulator], config, {
		GONDOLIN_VMM: "krun",
		GONDOLIN_KRUN_RUNNER: join(workspace, "missing-krun-runner"),
	});
}

vmTest("defaults to QEMU even when the SDK environment requests krun", () => {
	expectQemuDefault({});
}, 35_000);

vmTest("constructing a turn directly also defaults to QEMU", () => {
	expectQemuDefault();
}, 35_000);

vmTest("startup checks the QEMU emulator for the cached guest architecture", () => {
	const nativeEmulator = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
	const guestArch = process.arch === "arm64" ? "x86_64" : "aarch64";
	const assets = { kernel: "kernel", initramfs: "initramfs", rootfs: "rootfs" };
	const image = join(workspace, "guest-image");
	mkdirSync(image);
	for (const name of Object.values(assets)) writeFileSync(join(image, name), "fixture");
	writeFileSync(join(image, "manifest.json"), JSON.stringify({
		buildId: "99f935e1-c1d0-4e7e-bdfe-c855c2d4e2e7", config: { arch: guestArch }, assets,
	}));
	const result = runWithVmCommands(["qemu-img", nativeEmulator], `
		import { importImageFromDirectory, setImageRef } from "@earendil-works/gondolin";
		const { buildId, arch } = importImageFromDirectory(${JSON.stringify(image)});
		setImageRef(VM_SANDBOX_IMAGE, buildId, arch);
		await validateVMSandbox();
	`, { GONDOLIN_IMAGE_STORE: join(workspace, "image-store") });
	expect(result.exitCode, result.stderr.toString()).toBe(1);
	expect(result.stderr.toString()).toContain(`qemu-system-${guestArch} is not usable`);
}, 35_000);

krunTest("starts a configured krun turn without a QEMU system emulator", () => {
	expectSandboxToRun(["qemu-img"], { backend: "krun" }, { GONDOLIN_VMM: "qemu" });
}, 35_000);

for (const backend of ["qemu", "krun"] as const) {
	const resourceTest = backend === "qemu" ? vmTest : krunTest;
	resourceTest(`gives a ${backend} turn the build resource profile`, async () => {
		const turn = openTurn(new VMSandbox(1, { backend }));
		const result = await turn.exec(`set -e
			grep -c '^processor' /proc/cpuinfo
			awk '/^MemTotal:/ { print $2 }' /proc/meminfo
			df -kP / | awk 'NR == 2 { print $2 }'`, { timeout: 20 });
		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		const [cpus, memoryKiB, rootDiskKiB] = result.stdout.trim().split(/\s+/).map(Number);
		expect(cpus).toBe(2);
		// Guest-reported values exclude memory reserved by the kernel and filesystem overhead.
		expect(memoryKiB).toBeGreaterThan(2304 * 1024);
		expect(memoryKiB).toBeLessThanOrEqual(2560 * 1024);
		expect(rootDiskKiB).toBeGreaterThan(7 * 1024 * 1024);
		expect(rootDiskKiB).toBeLessThanOrEqual(8 * 1024 * 1024);
	}, 30_000);
}

test.each(["", "libkrun", null])("rejects an invalid backend from deployment config (%j)", async (backend) => {
	// @ts-expect-error Simulate config read at runtime without TypeScript validation.
	expect(() => new VMSandbox(1, { backend })).toThrow(SandboxConfigError);
	// @ts-expect-error Startup validation must reject the same invalid config.
	await expect(validateVMSandbox({ backend })).rejects.toThrow(SandboxConfigError);
});

const workspaceSecrets = {
	GEMINI_API_KEY: { value: "fixture-gemini-not-a-real-key", hosts: ["generativelanguage.googleapis.com"] },
	GH_TOKEN: { value: "fixture-github-not-a-real-pat", hosts: ["api.github.com"] },
};

webTest("allows public HTTPS and denies private destinations and off-host credentials", async () => {
	const command = "curl -fsS --max-time 8 https://example.com/";
	const web = openTurn(new VMSandbox(1, { secrets: workspaceSecrets }));
	const result = await web.exec(command, { timeout: 12 });
	expect(result.code, result.stderr).toBe(0);
	expect(result.stdout).toContain("Example Domain");

	// Route the request through the VM's virtual gateway, not the guest's own loopback.
	const loopback = await web.exec("curl -sS --max-time 8 --connect-to localhost:80:192.168.127.1:80 http://localhost/", { timeout: 12 });
	expect(loopback.code, loopback.stderr).toBe(0);
	expect(loopback.stdout).toContain("403 Forbidden: blocked by policy");

	for (const header of ["x-goog-api-key: $GEMINI_API_KEY", "Authorization: token $GH_TOKEN"]) {
		const misuse = await web.exec(`curl -sS --max-time 8 -w '|%{http_code}' -H "${header}" https://example.com/`, { timeout: 12 });
		expect(misuse).toEqual({ stdout: "The workspace credential is not allowed for this request.|403", stderr: "", code: 0 });
	}
}, 45_000);

test.each([
	{ header: "x-test-api-key" },
	{ hosts: [] },
	{ hosts: ["*.example.com"] },
	{ hosts: ["api.example.com:8443"] },
	{ hosts: ["api.example.com/path"] },
	{ value: "fixture\r\ninvalid" },
	{ request: { method: "POST", urls: ["https://api.example.com/unsupported"] } },
])("rejects invalid secret policy before starting a turn (%j)", (scope) => {
	expect(() => new VMSandbox(1, { secrets: { TEST_API_KEY: { hosts: ["api.example.com"], ...scope } } }))
		.toThrow("Invalid sandbox web secret");
});

test("rejects the old single-credential option instead of silently disabling it", () => {
	// @ts-expect-error Simulate a caller still passing the removed option at runtime.
	expect(() => new VMSandbox(1, { credential: {} })).toThrow("use secrets instead of credential");
});

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
	const otherChat = ensureChatDir(workspace, "43");
	writeFileSync(join(chat.chatDir, "context.jsonl"), "host state");
	writeFileSync(join(chat.attachmentsDir, "input.txt"), "incoming");
	writeFileSync(join(workspace, "skills", "shared.txt"), "shared skill");
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
	expect(readFileSync(join(chat.scratchDir, "work.txt"), "utf8")).toBe("scratch");
	expect(readFileSync(chat.memoryFile, "utf8")).toBe("note");
	await turn.close();
	const next = openTurn(sandbox);
	expect(await next.exec("test ! -e /tmp/turn && cat scratch/work.txt MEMORY.md")).toEqual({ stdout: "scratchnote", stderr: "", code: 0 });
}, 30_000);

vmTest("persists edits to the original attachment and reloads local and shared skills", async () => {
	const otherChat = ensureChatDir(workspace, "43");
	const attachment = join(chat.attachmentsDir, "input.txt");
	writeFileSync(attachment, "original");
	writeFileSync(join(otherChat.attachmentsDir, "input.txt"), "private");
	const sandbox = new VMSandbox(1, { writableWorkspaceContent: true });
	const turn = openTurn(sandbox);
	expect(loadChatSkills(chat)).toEqual([]);
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
	expect(loadChatSkills(chat).map(({ description }) => description)).toEqual(["For this chat"]);
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
		["/data/workspace/42/scratch", chat.scratchDir],
		["/data/workspace/42/attachments", chat.attachmentsDir],
		["/data/workspace/42/skills", chat.skillsDir],
		["/data/workspace/skills", join(workspace, "skills")],
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

test("a closed turn reports that the workspace sandbox has closed", async () => {
	const turn = openTurn(new VMSandbox(1));
	await turn.close();
	await expect(createBashTool(turn).execute("closed", { label: "Inspect workspace", command: "pwd" }))
		.rejects.toThrow("The workspace sandbox turn is closed.");
});

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
		const message = "Workspace VM cleanup failed; the bot must be restarted before starting another turn.";
		expect(outcome).toBe(message);
		await expect(openTurn(sandbox).exec("true", { timeout: 0.5 })).rejects.toThrow(message);
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
	const turn = openTurn(new VMSandbox(1));
	const result = createBashTool(turn).execute("missing-image", { label: "Check workspace", command: "true", timeout: 0.1 })
		.catch((error: Error) => error);
	try {
		const outcome = await Promise.race([result, Bun.sleep(600).then(() => "turn is still waiting")]);
		expect(outcome).toBeInstanceOf(SandboxConfigError);
		if (!(outcome instanceof SandboxConfigError)) throw new Error("Expected a sandbox configuration error");
		expect(outcome.message).toBe("The workspace VM image is unavailable. Ask the bot operator to run startup validation.");
		expect(outcome.cause).toBeInstanceOf(Error);
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
	const turn = openTurn(new VMSandbox(1));
	const result = await createReadTool(turn).execute("read", { label: "Read header", path: "scratch/large.txt", limit: 1 });
	expect(result.content).toEqual([{ type: "text", text: "first\n\n[1 more lines in file. Use offset=2 to continue]" }]);
	expect((await turn.exec("echo still-running")).stdout).toBe("still-running\n");
}, 30_000);

vmTest("exports guest bytes from the current chat without accepting host paths", async () => {
	const turn = openTurn(new VMSandbox(1));
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

vmTest("exports from the mounted directory even if the caller updates its paths", async () => {
	const paths = { ...chat };
	const turn = openTurn(new VMSandbox(1), paths);
	expect((await turn.exec("printf mounted > scratch/file.txt")).code).toBe(0);
	const otherDir = join(workspace, "other-scratch");
	mkdirSync(otherDir);
	writeFileSync(join(otherDir, "file.txt"), "not mounted");
	paths.scratchDir = otherDir;
	await expect(turn.readAttachment("/workspace/42/scratch/file.txt")).resolves.toEqual(Buffer.from("mounted"));
}, 30_000);

vmTest("checks entries against the original relative mount after a host cwd change", () => {
	const otherCwd = join(workspace, "other-cwd");
	mkdirSync(otherCwd);
	const file = join(chat.scratchDir, "original.txt");
	writeFileSync(file, "fixture");
	linkSync(file, join(chat.scratchDir, "linked.txt"));
	const emulator = process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
	const result = runWithVmCommands(["qemu-img", emulator], `
		import assert from "node:assert/strict";
		import { relative } from "node:path";
		process.chdir(${JSON.stringify(workspace)});
		const paths = Object.fromEntries(Object.entries(${JSON.stringify(chat)})
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

vmTest("rejects attachments larger than 10 MiB without closing the turn", async () => {
	const file = join(chat.scratchDir, "limit.bin");
	writeFileSync(file, "fixture");
	truncateSync(file, 10 * 1024 * 1024);
	const turn = openTurn(new VMSandbox(1));
	const path = "/workspace/42/scratch/limit.bin";
	expect((await turn.readAttachment(path)).length).toBe(10 * 1024 * 1024);
	truncateSync(file, 10 * 1024 * 1024 + 1);
	await expect(turn.readAttachment(path)).rejects.toThrow("maximum file size is 10 MiB");
	expect(await turn.exec("true")).toEqual({ stdout: "", stderr: "", code: 0 });
}, 30_000);

for (const backend of ["qemu", "krun"] as const) {
	const sandboxTest = backend === "qemu" ? vmTest : krunTest;
	sandboxTest(`rejects existing unsafe entries in ${backend} workspace mounts and attachment exports`, async () => {
		for (const dir of [chat.scratchDir, chat.attachmentsDir]) {
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
