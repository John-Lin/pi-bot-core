import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VMSandbox, validateVMSandbox } from "pi-bot-core/vm-sandbox";
import { SandboxConfigError } from "../src/sandbox.js";
import { createBashTool } from "../src/tools/bash.js";
import { krunTest, useVMSandboxFixture, vmTest, webTest, workspaceSecrets } from "./helpers/vm-sandbox.js";

const fixture = useVMSandboxFixture();
const { openTurn, runWithVmCommands } = fixture;

function expectSandboxToRun(commands: string[], config: object | undefined, env: Record<string, string>): void {
	const result = runWithVmCommands(commands, `
		const config = ${JSON.stringify(config)};
		await validateVMSandbox(config);
		const paths = ${JSON.stringify(fixture.chat)};
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
		GONDOLIN_KRUN_RUNNER: join(fixture.workspace, "missing-krun-runner"),
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
	const image = join(fixture.workspace, "guest-image");
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
	`, { GONDOLIN_IMAGE_STORE: join(fixture.workspace, "image-store") });
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

test("a closed turn reports that the workspace sandbox has closed", async () => {
	const turn = openTurn(new VMSandbox(1));
	await turn.close();
	await expect(createBashTool(turn).execute("closed", { label: "Inspect workspace", command: "pwd" }))
		.rejects.toThrow("The workspace sandbox turn is closed.");
});

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
	process.env.GONDOLIN_IMAGE_STORE = join(fixture.workspace, "empty-image-store");
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
