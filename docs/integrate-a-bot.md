# Integrate a bot with pi-bot-core

This guide shows how to wire a chat bot to `pi-bot-core` from startup validation through per-chat sessions, per-turn VM tool runs, progress updates, and teardown.

## Validate startup dependencies and configuration

Run workspace checks, configuration loaders, and VM sandbox validation during bot startup so invalid settings fail before the bot accepts messages.

1. Validate the workspace path before any workspace storage I/O and seed missing bootstrap files.
2. Load `agent-settings.json` and `mcp.json`.
3. Pass the same `VMSandboxOptions` object to `validateVMSandbox` and `new VMSandbox` so the validated backend matches runtime turns.

```ts
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadBotMcpConfig } from "pi-bot-core/agent-extensions";
import { loadAgentSettings } from "pi-bot-core/agent-settings";
import {
	VMSandbox,
	validateVMSandbox,
	type VMSandboxOptions,
} from "pi-bot-core/vm-sandbox";
import {
	ensureWorkspaceBootstrap,
	ensureWorkspacePathIsSafe,
} from "pi-bot-core/workspace-bootstrap";

const workspace = "/var/lib/example-bot/workspace";

ensureWorkspacePathIsSafe(workspace);
ensureWorkspaceBootstrap(workspace);

const { contextWindow, settings } = loadAgentSettings("config/agent-settings.json");
const settingsManager = SettingsManager.inMemory(settings);
// Apply contextWindow to the resolved model when defined.

const mcp = loadBotMcpConfig("config/mcp.json");

const sandboxOptions: VMSandboxOptions = {
	backend: "qemu", // Set "krun" to opt in to libkrun.
};

await validateVMSandbox(sandboxOptions);
const sandbox = new VMSandbox(2, sandboxOptions);
```

To inject scoped host credentials into guest HTTP requests, add a `secrets` map to `sandboxOptions`.

```ts
const sandbox = new VMSandbox(2, {
	secrets: {
		GEMINI_API_KEY: {
			value: process.env.GEMINI_API_KEY,
			hosts: ["generativelanguage.googleapis.com"],
		},
		GH_TOKEN: {
			value: process.env.BOT_GITHUB_PAT,
			hosts: ["api.github.com", "github.com"],
		},
	},
});
```

Keep each token in its raw form on the host without an auth scheme prefix. Omit `github.com` if the guest only needs GitHub API access.

See [VM sandbox reference](vm-sandbox.md) for host requirements and secret rules. See [Agent settings and MCP extensions reference](agent-extensions.md) for config schemas.

## Create a per-chat session with Codemode and MCP

Create one `createBotAgentExtensions` runtime for each chat `AgentSession`. Disable Pi discovery on `DefaultResourceLoader` so the bot controls all extensions, skills, and prompts.

```ts
import {
	AgentSession,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { createBotAgentExtensions } from "pi-bot-core/agent-extensions";

let turnSystemPrompt = "";

const extensions = createBotAgentExtensions({
	name: "example-bot",
	mcp,
	mcpLogPath: join(homedir(), ".pi", "example-bot", "mcp.log"),
	systemPrompt: () => turnSystemPrompt,
});

const resourceLoader = new DefaultResourceLoader({
	cwd: chatDir,
	agentDir: getAgentDir(),
	settingsManager,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	systemPromptOverride: () => "",
	appendSystemPromptOverride: () => [],
	extensionFactories: extensions.extensions,
});
await resourceLoader.reload();

const session = new AgentSession({
	agent,
	sessionManager,
	settingsManager,
	cwd: chatDir,
	modelRuntime,
	resourceLoader,
	baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
	initialActiveToolNames: [
		...tools.map((tool) => tool.name),
		...extensions.activeToolNames,
	],
});

const headlessUi = session.extensionRunner.getUIContext();
await session.bindExtensions({
	uiContext: {
		...headlessUi,
		notify: (message, type) => {
			// Log warnings and rewrite the SDK "/mcp" hint for operators.
		},
	},
	onError: (error) => {
		// Log extension handler failures.
	},
});
```

## Run a turn with VM workspace tools

Open a fresh `VMSandboxTurn` for each turn and close it in a `finally` block. Revalidate the workspace before reading bootstrap files so edits apply on the next run.

1. Call `ensureWorkspacePathIsSafe(workspace)` and `ensureChatDir(workspace, chatId)`.
2. Call `sandbox.turn(paths)` to create the lazy turn executor.
3. Build the workspace tools with `createBotTools(turn)`, or pick individual tools such as `createBashTool(turn)` and `createReadTool(turn)`.
4. Wire `createAttachTool` to `turn.readAttachment` instead of reading guest-supplied paths on the host.
5. Build the turn prompt with `WORKSPACE_GUEST_ROOT`, and pass the same `writableWorkspaceContent` flag you gave `VMSandbox`.
6. Prefix user messages with trusted timestamp and sender metadata before calling `session.prompt`. Never pass raw user text to `session.prompt` because a leading `/` dispatches SDK commands such as `/mcp login`.
7. Clear the attachment uploader and close `turn` in `finally`.

```ts
import {
	buildBaseSystemPrompt,
	createAttachTool,
	createBotTools,
	createChatHistoryTool,
	createScheduleTool,
} from "pi-bot-core";
import { WORKSPACE_GUEST_ROOT } from "pi-bot-core/vm-sandbox";
import { ensureChatDir, loadChatSkills, readMemory } from "pi-bot-core/workspace";
import {
	ensureWorkspacePathIsSafe,
	readWorkspaceBootstrap,
} from "pi-bot-core/workspace-bootstrap";

ensureWorkspacePathIsSafe(workspace);
const paths = ensureChatDir(workspace, chatId);
const turn = sandbox.turn(paths);

const attach = createAttachTool();
attach.setUploader(async (guestPath, { label, fileName }) => {
	const bytes = await turn.readAttachment(guestPath);
	await uploadAttachment(bytes, { label, fileName });
});

try {
	const turnTools = [
		...createBotTools(turn),
		attach.tool,
		createChatHistoryTool({ logFilePath }),
		createScheduleTool(scheduleConfig),
	];
	// Bind turnTools to the session or agent for this turn.

	// Omit the visible path argument because bootstrap files stay on the host.
	const bootstrap = readWorkspaceBootstrap(workspace);
	const memory = readMemory(paths);
	const skills = loadChatSkills(paths, WORKSPACE_GUEST_ROOT);
	const basePrompt = buildBaseSystemPrompt({
		workspacePath: WORKSPACE_GUEST_ROOT,
		conversationId: String(chatId),
		botUsername,
		skills,
		memory,
		writableWorkspaceContent: sandboxOptions.writableWorkspaceContent,
		platform,
		liveStateLines,
	});
	turnSystemPrompt = `${bootstrap}\n\n${basePrompt}`;

	await session.prompt(prefixedUserMessage);
} finally {
	attach.setUploader(null);
	await turn.close();
}
```

If you only need a subset of the workspace tools, construct them individually:

```ts
import { createBashTool, createReadTool } from "pi-bot-core";

const tools = [createBashTool(turn), createReadTool(turn)];
```

See [Workspace and runtime modules reference](workspace-and-runtime.md) for `createScheduleTool`, `EventsWatcher`, `MessageLog`, and Telegraph tools.

## Track tool progress during a run

Create a new `ProgressTracker` inside each run and forward SDK session events to it. Preserve `toolCallId`, `parentToolCallId`, and optional `durationMs` as emitted by the SDK. Do not substitute `0` when `durationMs` is absent.

```ts
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ProgressTracker } from "pi-bot-core/progress";

const progress = new ProgressTracker();

function onSessionEvent(event: AgentSessionEvent): void {
	switch (event.type) {
		case "tool_execution_start": {
			const args: unknown = event.args;
			const label = typeof args === "object" && args !== null && "label" in args
				&& typeof args.label === "string" ? args.label : undefined;
			progress.apply({
				type: "tool_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				parentToolCallId: event.parentToolCallId,
				label,
			});
			break;
		}
		case "tool_execution_end":
			progress.apply({
				type: "tool_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				parentToolCallId: event.parentToolCallId,
				isError: event.isError,
				durationMs: event.durationMs,
			});
			break;
		case "compaction_start":
			progress.apply({ type: "compaction" });
			break;
		case "auto_retry_start":
			progress.apply({
				type: "retry",
				attempt: event.attempt,
				max: event.maxAttempts,
			});
			break;
	}
}
```

Call `progress.render()` for plain-text channels. For Markdown-enabled channels such as Discord, pass an escaping function so tool names and labels do not break formatting:

```ts
import { escapeMarkdown } from "discord.js";

const body = progress.render(escapeMarkdown);
```

Discard the tracker and remove its event subscription when the run ends. See [Progress tracker reference](progress.md) for row limits and rendering rules.

## Shut down a chat session

Run these teardown steps in order because `AgentSession.dispose()` does not emit `session_shutdown`:

1. Emit `session_shutdown` so the SDK MCP extension stops its managed connections.
2. Await `extensions.close()` to close any transports still connecting or reconnecting.
3. Call `session.dispose()` when your run and abort handling allows it.

```ts
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
await extensions.close();
session.dispose();
```
