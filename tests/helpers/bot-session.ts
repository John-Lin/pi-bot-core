/**
 * Test harness that wires `createBotAgentExtensions` into a real SDK `AgentSession` exactly as the
 * README caller contract describes, inside an isolated HOME / agent directory. No model is ever
 * called: tool calls are driven through the SDK tool pipeline with synthetic assistant messages.
 */
import { Agent, runToolCall, type AgentTool, type AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
	AgentSession,
	convertToLlm,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	type BotAgentExtensions,
	type BotMcpConfig,
	createBotAgentExtensions,
} from "../../src/agent-extensions.js";

export const STDIO_FIXTURE = join(import.meta.dir, "..", "fixtures", "mcp-stdio-server.ts");

/** Temporary HOME, agent directory, and chat directory; `restore()` resets env and deletes them. */
export interface IsolatedEnvironment {
	root: string;
	home: string;
	agentDir: string;
	cwd: string;
	mcpLogPath: string;
	restore(): void;
}

export function isolateEnvironment(prefix: string): IsolatedEnvironment {
	const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const cwd = join(root, "chat");
	for (const dir of [home, agentDir, cwd]) mkdirSync(dir, { recursive: true });
	const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	// Pi reads HOME for project trust; Bun's os.homedir() stays fixed at process start.
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return {
		root,
		home,
		agentDir,
		cwd,
		mcpLogPath: join(root, "logs", "mcp.log"),
		restore() {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export interface Notification {
	message: string;
	type?: "info" | "warning" | "error";
}

export interface BotSession {
	session: AgentSession;
	runtime: BotAgentExtensions;
	notifications: Notification[];
	extensionErrors: string[];
	/** Caller-owned shutdown order from the README: session_shutdown, close, then dispose. */
	shutdown(): Promise<void>;
}

export async function createBotSession(env: IsolatedEnvironment, options: {
	mcp?: BotMcpConfig;
	tools?: AgentTool<any>[];
	systemPrompt?: () => string;
} = {}): Promise<BotSession> {
	const tools = options.tools ?? [];
	const runtime = createBotAgentExtensions({
		name: "test-bot",
		mcp: options.mcp,
		mcpLogPath: env.mcpLogPath,
		systemPrompt: options.systemPrompt ?? (() => "Test prompt"),
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(env.root, "auth.json"),
		modelsPath: join(env.root, "models.json"),
	});
	const model = modelRuntime.getModel("openai", "gpt-5.4");
	if (!model) throw new Error("Built-in test model is missing");
	const agent = new Agent({
		initialState: { model, systemPrompt: "", tools },
		streamFn: () => {
			throw new Error("Tests must not call a model");
		},
		convertToLlm,
	});
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: env.cwd,
		agentDir: env.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => "",
		appendSystemPromptOverride: () => [],
		extensionFactories: runtime.extensions,
	});
	await resourceLoader.reload();
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(env.cwd),
		settingsManager,
		cwd: env.cwd,
		modelRuntime,
		resourceLoader,
		baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
		initialActiveToolNames: [...tools.map((tool) => tool.name), ...runtime.activeToolNames],
	});
	const notifications: Notification[] = [];
	const extensionErrors: string[] = [];
	await session.bindExtensions({
		uiContext: {
			...session.extensionRunner.getUIContext(),
			notify: (message, type) => notifications.push({ message, type }),
		},
		onError: (error) => extensionErrors.push(`${error.extensionPath} ${error.event}: ${error.error}`),
	});
	let shutdown: Promise<void> | undefined;
	return {
		session,
		runtime,
		notifications,
		extensionErrors,
		shutdown() {
			shutdown ??= (async () => {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				await runtime.close();
				session.dispose();
			})();
			return shutdown;
		},
	};
}

/** Run one tool call through the session's real tool pipeline from a synthetic assistant message. */
export async function runTool(
	session: AgentSession,
	name: string,
	args: ToolCall["arguments"],
): Promise<AgentToolCallOutcome> {
	const toolCall: ToolCall = { type: "toolCall", id: `call-${crypto.randomUUID()}`, name, arguments: args };
	const message: AssistantMessage = {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		content: [toolCall],
		stopReason: "toolUse",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	session.agent.state.messages.push(message);
	const tools = session.agent.state.tools;
	return runToolCall(toolCall, {
		tools,
		assistantMessage: message,
		context: { messages: session.agent.state.messages, tools },
		beforeToolCall: session.agent.beforeToolCall,
		afterToolCall: session.agent.afterToolCall,
	});
}

export function runCodemode(session: AgentSession, code: string): Promise<AgentToolCallOutcome> {
	return runTool(session, "codemode", { code });
}

export function outputText(outcome: AgentToolCallOutcome): string {
	return outcome.result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

export async function waitFor(check: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
		await Bun.sleep(10);
	}
}

export function waitForFileContent(path: string, marker: string): Promise<void> {
	return waitFor(
		() => existsSync(path) && readFileSync(path, "utf8").includes(marker),
		`${marker} in ${path}`,
	);
}

/** Kill fixtures a failed test left running so they cannot outlive the test process. */
export function killStartedFixture(path: string): void {
	if (!existsSync(path)) return;
	const log = readFileSync(path, "utf8");
	for (const match of log.matchAll(/started:(\d+):/g)) {
		if (log.includes(`stopped:${match[1]}\n`)) continue;
		try {
			process.kill(Number(match[1]), "SIGKILL");
		} catch {}
	}
}
