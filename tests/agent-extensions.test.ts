import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, relative } from "path";
import { createBotTools, HostExecutor } from "../src/index.js";
import { type BotMcpConfig, loadBotMcpConfig } from "pi-bot-core/agent-extensions";
import { startMcpHttpServer } from "./fixtures/mcp-http-server.js";
import {
	type BotSession,
	createBotSession,
	type IsolatedEnvironment,
	isolateEnvironment,
	killStartedFixture,
	outputText,
	runCodemode,
	runTool,
	STDIO_FIXTURE,
	waitFor,
	waitForFileContent,
} from "./helpers/bot-session.js";

let env: IsolatedEnvironment;
let sessions: BotSession[];
let servers: Array<{ stop(): void }>;
let lifecycleFiles: string[];

beforeEach(() => {
	env = isolateEnvironment("pi-bot-core-agent-extensions-");
	sessions = [];
	servers = [];
	lifecycleFiles = [];
});

afterEach(async () => {
	try {
		await Promise.all(sessions.map((bot) => bot.shutdown()));
		for (const server of servers) server.stop();
		for (const path of lifecycleFiles) killStartedFixture(path);
	} finally {
		env.restore();
	}
});

async function start(options: Parameters<typeof createBotSession>[1] = {}): Promise<BotSession> {
	const bot = await createBotSession(env, options);
	sessions.push(bot);
	return bot;
}

function httpServer() {
	const server = startMcpHttpServer();
	servers.push(server);
	return server;
}

function lifecyclePath(name: string): string {
	const path = join(env.root, `${name}.log`);
	lifecycleFiles.push(path);
	return path;
}

function stdioServer(name: string, config: { env?: Record<string, string>; description?: string } = {}): BotMcpConfig {
	return {
		servers: [{
			name,
			config: { command: process.execPath, args: [STDIO_FIXTURE], ...config },
		}],
	};
}

function beforeAgentStart(bot: BotSession) {
	return bot.session.extensionRunner.emitBeforeAgentStart(
		{ messageType: "user", prompt: "hi" },
		{ cwd: env.cwd, sections: {} },
	);
}

describe("createBotAgentExtensions without MCP servers", () => {
	test("activates codemode beside native tools without loading MCP or tool search", async () => {
		const tools = createBotTools(new HostExecutor());
		const bot = await start({ tools });

		expect(bot.runtime.activeToolNames).toEqual(["codemode"]);
		expect(bot.session.getActiveToolNames().sort()).toEqual(["bash", "codemode", "edit", "read", "write"]);
		expect(bot.session.getAllTools().map((tool) => tool.name)).not.toContain("tool_search");
		expect(bot.session.extensionRunner.getCommand("mcp")).toBeUndefined();
		expect(bot.notifications).toEqual([]);
		expect(bot.extensionErrors).toEqual([]);
	});

	test("batches native tool calls from one codemode script", async () => {
		const first = join(env.cwd, "first.txt");
		const second = join(env.cwd, "second.txt");
		writeFileSync(first, "FIRST_NATIVE_MARKER");
		writeFileSync(second, "SECOND_NATIVE_MARKER");
		const bot = await start({ tools: createBotTools(new HostExecutor()) });

		const outcome = await runCodemode(bot.session, `
			const [a, b] = await Promise.all([
				tools.read({ label: "first", path: ${JSON.stringify(first)} }),
				tools.read({ label: "second", path: ${JSON.stringify(second)} }),
			]);
			return [a, b].join("|");
		`);

		expect(outcome.isError, outputText(outcome)).toBe(false);
		expect(outputText(outcome)).toContain("FIRST_NATIVE_MARKER|SECOND_NATIVE_MARKER");
		expect(bot.notifications).toEqual([]);
		expect(bot.extensionErrors).toEqual([]);
	});

	test("does not expose the models API to codemode scripts", async () => {
		const bot = await start();

		const outcome = await runCodemode(bot.session, `
			if (typeof models !== "undefined") throw new Error("models namespace exposed");
			return "MODELS_NAMESPACE_DISABLED";
		`);

		expect(outcome.isError, outputText(outcome)).toBe(false);
		expect(outputText(outcome)).toContain("MODELS_NAMESPACE_DISABLED");
	});

	test("forces the current platform prompt on every turn", async () => {
		let prompt = "First turn\n\n## Live State\nfirst";
		const bot = await start({ systemPrompt: () => prompt });

		expect((await beforeAgentStart(bot)).systemPromptOptions.forceSystemPrompt).toBe(prompt);
		prompt = "Second turn\n\n## Live State\nsecond";
		expect((await beforeAgentStart(bot)).systemPromptOptions.forceSystemPrompt).toBe(prompt);
		expect(bot.extensionErrors).toEqual([]);
	});
});

describe("createBotAgentExtensions MCP prompt directory", () => {
	test("places the MCP server directory before the trailing Live State", async () => {
		const prefix = "Platform rules\n\n## Live State\nnot the trailing heading";
		const liveState = "\n\n## Live State\nsender: alice";
		const bot = await start({
			mcp: stdioServer("fixture", { description: "Test host tools" }),
			systemPrompt: () => `${prefix}${liveState}`,
		});

		const prompt = (await beforeAgentStart(bot)).systemPromptOptions.forceSystemPrompt!;

		expect(prompt.startsWith(`${prefix}\n\n<mcp_servers>\n`)).toBe(true);
		expect(prompt.endsWith(`</mcp_servers>${liveState}`)).toBe(true);
		const directory = prompt.slice(prefix.length, prompt.length - liveState.length);
		expect(directory).toContain("mcp__fixture");
		expect(directory).toContain("Test host tools");
		expect(bot.extensionErrors).toEqual([]);
	});

	test("appends the MCP server directory when the prompt has no Live State", async () => {
		const bot = await start({
			mcp: stdioServer("fixture", { description: "Test host tools" }),
			systemPrompt: () => "Platform rules",
		});

		const prompt = (await beforeAgentStart(bot)).systemPromptOptions.forceSystemPrompt!;

		expect(prompt).toStartWith("Platform rules\n\n<mcp_servers>\n");
		expect(prompt).toEndWith("</mcp_servers>");
		expect(prompt).toContain("mcp__fixture");
	});
});

describe("createBotAgentExtensions MCP transports", () => {
	test("calls a stdio server in the bot process without loading personal or project MCP config", async () => {
		const personal = lifecyclePath("personal");
		const project = lifecyclePath("project");
		const configured = lifecyclePath("configured");
		writeFileSync(join(env.agentDir, "mcp.json"), JSON.stringify({
			mcpServers: { personal: { command: process.execPath, args: [STDIO_FIXTURE], env: { MCP_TEST_LIFECYCLE_PATH: personal } } },
		}));
		mkdirSync(join(env.cwd, ".pi"));
		writeFileSync(join(env.cwd, ".pi", "mcp.json"), JSON.stringify({
			mcpServers: { project: { command: process.execPath, args: [STDIO_FIXTURE], env: { MCP_TEST_LIFECYCLE_PATH: project } } },
		}));
		const bot = await start({ mcp: stdioServer("fixture", { env: { MCP_TEST_LIFECYCLE_PATH: configured } }) });

		const outcome = await runCodemode(bot.session, 'return await tools.mcp__fixture__echo_host({ text: "hello" });');

		expect(outcome.isError, outputText(outcome)).toBe(false);
		expect(outputText(outcome)).toContain("HOST_MCP:hello");
		expect(readFileSync(configured, "utf8")).toContain(`:${env.cwd}\n`);
		const names = bot.session.getAllTools().map((tool) => tool.name);
		expect(names.some((name) => name.startsWith("mcp__personal") || name.startsWith("mcp__project"))).toBe(false);
		expect(existsSync(personal)).toBe(false);
		expect(existsSync(project)).toBe(false);
		expect(bot.notifications).toEqual([]);
		expect(bot.extensionErrors).toEqual([]);
	});

	test("writes server log notifications to the caller's MCP log path", async () => {
		const bot = await start({ mcp: stdioServer("fixture", { env: { MCP_TEST_LOG_MESSAGE: "FIXTURE_LOG_MARKER" } }) });

		const outcome = await runCodemode(bot.session, 'return await tools.mcp__fixture__echo_host({ text: "log" });');

		expect(outcome.isError, outputText(outcome)).toBe(false);
		await waitForFileContent(env.mcpLogPath, "FIXTURE_LOG_MARKER");
		expect(existsSync(join(env.agentDir, "mcp.log"))).toBe(false);
	});

	test("expands home paths, cwd, and trusted env interpolation for stdio servers", async () => {
		// Bun fixes os.homedir() at startup, so `~/` paths reach the temporary fixtures relative to it.
		const fromHome = (path: string) => `~/${relative(homedir(), path)}`;
		const cwd = join(env.root, "work");
		mkdirSync(cwd);
		process.env.MCP_TEST_SUBSTITUTION = "test-token";
		try {
			const bot = await start({
				mcp: { servers: [{ name: "local", config: {
					command: fromHome(process.execPath), args: [fromHome(STDIO_FIXTURE), "~/asset"], cwd: fromHome(cwd),
					env: {
						MCP_TEST_REPORT_CONTEXT: "1",
						MCP_TEST_EXPANDED: "$MCP_TEST_SUBSTITUTION/${MCP_TEST_SUBSTITUTION}",
						MCP_TEST_COMMAND: "!printf command-token",
						MCP_TEST_ESCAPED: "$$MCP_TEST_SUBSTITUTION",
						MCP_TEST_LITERAL: "$!do-not-execute",
					},
				} }] },
			});

			const outcome = await runCodemode(bot.session,
				'const result = await tools.mcp__local__echo_host({ text: "context" }); return JSON.parse(result.content[0].text);');

			expect(outcome.isError, outputText(outcome)).toBe(false);
			expect(outputText(outcome)).toContain(JSON.stringify({
				cwd, args: [join(homedir(), "asset")], expanded: "test-token/test-token",
				command: "command-token", escaped: "$MCP_TEST_SUBSTITUTION", literal: "!do-not-execute",
			}));
			expect(bot.notifications).toEqual([]);
		} finally {
			delete process.env.MCP_TEST_SUBSTITUTION;
		}
	});

	test("calls a streamable HTTP server with interpolated and escaped headers", async () => {
		const server = httpServer();
		process.env.MCP_TEST_SUBSTITUTION = "test-token";
		try {
			const bot = await start({
				mcp: { servers: [{ name: "remote", config: { url: server.url, headers: {
					Authorization: "$MCP_TEST_SUBSTITUTION/${MCP_TEST_SUBSTITUTION}/$$/$!literal",
					"X-Command-Value": "!printf command-token",
				} } }] },
			});

			const outcome = await runCodemode(bot.session, 'return await tools.mcp__remote__echo_http({ text: "headers" });');

			expect(outcome.isError, outputText(outcome)).toBe(false);
			expect(outputText(outcome)).toContain("HTTP_MCP:headers");
			expect(server.authorization).toBe("test-token/test-token/$/!literal");
			expect(server.commandHeader).toBe("command-token");
			expect(bot.notifications).toEqual([]);
		} finally {
			delete process.env.MCP_TEST_SUBSTITUTION;
		}
	});

	test.each([
		{ value: "$MCP_TEST_MISSING_VALUE", error: "missing environment variable MCP_TEST_MISSING_VALUE" },
		{ value: "!printf SECRET_COMMAND_OUTPUT >&2; exit 1", error: "command failed" },
		{ value: "!printf ''", error: "command failed" },
	])("reports invalid header value $value without contacting the server", async ({ value, error }) => {
		const server = httpServer();
		const bot = await start({
			mcp: { servers: [{ name: "remote", config: { url: server.url, headers: { Authorization: value } } }] },
		});

		await waitFor(() => bot.notifications.length > 0, "MCP warning");

		expect(bot.notifications).toHaveLength(1);
		expect(bot.notifications[0]!.type).toBe("warning");
		expect(bot.notifications[0]!.message).toContain(`MCP server "remote" header "Authorization": ${error}`);
		expect(bot.notifications[0]!.message).not.toContain("SECRET_COMMAND_OUTPUT");
		expect(server.requests).toEqual([]);
	});
});

describe("createBotAgentExtensions MCP exposure", () => {
	for (const exposure of ["codemode", "codemode-deferred", "deferred", "direct", "hidden"] as const) {
		test(`keeps ${exposure} tools reachable only through their configured exposure`, async () => {
			const server = httpServer();
			const configPath = join(env.root, "mcp.json");
			writeFileSync(configPath, JSON.stringify({ mcpServers: { remote: { url: server.url, exposure } } }));
			const bot = await start({ mcp: loadBotMcpConfig(configPath) });

			const outcome = await runCodemode(bot.session, 'return await tools.mcp__remote__echo_http({ text: "exposure" });');

			expect(outputText(outcome)).toContain(exposure === "hidden" ? "does not exist" : "HTTP_MCP:exposure");
			const active = bot.session.getActiveToolNames();
			expect(active.includes("mcp__remote__echo_http")).toBe(exposure === "direct");
			expect(active).toContain("codemode");
			expect(active.includes("tool_search")).toBe(exposure === "deferred");
			expect(bot.notifications).toEqual([]);
		});
	}

	const toolExposureCases: Array<Record<string, "direct" | "hidden">> = [
		{ echo_http: "direct", "echo_*": "hidden" },
		{ "echo_*": "direct" },
	];
	for (const toolExposure of toolExposureCases) {
		test(`honors ${Object.hasOwn(toolExposure, "echo_http") ? "exact" : "pattern"} tool exposure and leaves disabled servers untouched`, async () => {
			const server = httpServer();
			const disabled = httpServer();
			const bot = await start({ mcp: { servers: [
				{ name: "remote", config: { url: server.url, exposure: "hidden", toolExposure } },
				{ name: "disabled", config: { url: disabled.url, exposure: "direct", enabled: false } },
			] } });

			await waitFor(() => bot.session.getActiveToolNames().includes("mcp__remote__echo_http"), "direct MCP tool");
			const outcome = await runTool(bot.session, "mcp__remote__echo_http", { text: "override" });

			expect(outcome.isError, outputText(outcome)).toBe(false);
			expect(outputText(outcome)).toBe("HTTP_MCP:override");
			expect(bot.session.getAllTools().map((tool) => tool.name)).not.toContain("mcp__disabled__echo_http");
			expect(disabled.requests).toEqual([]);
			expect(bot.notifications).toEqual([]);
		});
	}

	test("tool search loads deferred MCP tools for direct calls", async () => {
		const server = httpServer();
		const bot = await start({ mcp: { servers: [{ name: "remote", config: { url: server.url, exposure: "deferred" } }] } });
		expect(bot.session.getActiveToolNames()).not.toContain("mcp__remote__echo_http");

		const search = await runTool(bot.session, "tool_search", { query: "echo_http", limit: 1 });

		expect(search.isError, outputText(search)).toBe(false);
		expect(bot.session.getActiveToolNames()).toContain("mcp__remote__echo_http");
		const outcome = await runTool(bot.session, "mcp__remote__echo_http", { text: "loaded" });
		expect(outputText(outcome)).toBe("HTTP_MCP:loaded");
		expect(bot.notifications).toEqual([]);
	});
});

describe("createBotAgentExtensions cleanup", () => {
	test("caller shutdown stops a connected stdio server", async () => {
		const path = lifecyclePath("connected");
		const bot = await start({ mcp: stdioServer("fixture", { env: { MCP_TEST_LIFECYCLE_PATH: path } }) });
		await runCodemode(bot.session, 'return await tools.mcp__fixture__echo_host({ text: "lifecycle" });');

		await bot.shutdown();

		await waitForFileContent(path, "stopped:");
	});

	test("close stops a stdio server that is still connecting and is idempotent", async () => {
		const path = lifecyclePath("connecting");
		const bot = await start({
			mcp: stdioServer("fixture", { env: { MCP_TEST_LIFECYCLE_PATH: path, MCP_TEST_HANG_INITIALIZE: "1" } }),
		});
		await waitForFileContent(path, "started:");

		await Promise.all([bot.runtime.close(), bot.runtime.close()]);

		await waitForFileContent(path, "stopped:");
		await bot.runtime.close();
		await bot.shutdown();
		expect(bot.extensionErrors).toEqual([]);
	});

	test("close without MCP servers resolves repeatedly", async () => {
		const bot = await start();

		await bot.runtime.close();
		await bot.runtime.close();
		await bot.shutdown();
	});

	test("caller shutdown interrupts an active HTTP reconnect without waiting for its timeout", async () => {
		const server = httpServer();
		const bot = await start({
			mcp: { servers: [{ name: "remote", config: { url: server.url, exposure: "direct", timeout: 2 } }] },
		});
		await waitFor(() => bot.session.getActiveToolNames().includes("mcp__remote__echo_http"), "direct MCP tool");
		expect(outputText(await runTool(bot.session, "mcp__remote__echo_http", { text: "first" }))).toBe("HTTP_MCP:first");
		const reconnecting = server.expireSession();
		const call = runTool(bot.session, "mcp__remote__echo_http", { text: "second" });
		await reconnecting;

		const outcome = await Promise.race([
			bot.shutdown().then(() => "stopped"),
			Bun.sleep(500).then(() => "blocked"),
		]);

		expect(outcome).toBe("stopped");
		const result = await call;
		expect(result.isError).toBe(true);
		expect(outputText(result)).toContain("MCP connection closed");
	});
});
