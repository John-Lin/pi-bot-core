# pi-bot-core

Shared runtime and building blocks for pi-mono based bots (e.g. `pi-discord-bot`, `pi-telegram-bot`).

Inspired by [pi-mono](https://github.com/badlogic/pi-mono); some modules were originally ported from `pi-mono/packages/mom` and remain MIT-licensed under the original copyright. See `LICENSE`.

The `Executor` abstraction lets the same agent tools work on the host or inside a Docker container without tool changes. Higher-level modules (workspace, message log, event scheduler, telegraph, …) are pulled out of the individual bot repos so they share one implementation.

## Contents

### Sandbox / Executor (`pi-bot-core`, `pi-bot-core/sandbox`)

- `Executor` interface
- `HostExecutor` — runs commands locally via `sh -c`
- `DockerExecutor` — runs commands inside a running container via `docker exec ... sh -c`
- `createExecutor(config)` / `parseSandboxArg(arg)` / `validateSandbox(config)` helpers

### Agent tools (`pi-bot-core/tools`)

All tools are `AgentTool` instances from `@earendil-works/pi-agent-core` and drop into any Agent session.

- `createBashTool(executor)` — run bash with tail truncation + temp file spill
- `createReadTool(executor)` — read text files (offset/limit) and images (base64)
- `createWriteTool(executor)` — write files, creates parent dirs
- `createEditTool(executor)` — exact-match text replacement with unified diff output
- `createAttachTool()` — let the LLM upload a file back to the user; bot wires the platform-specific uploader
- `createChatHistoryTool({ logFilePath })` — search the conversation's `log.jsonl` (respects edit/delete tombstones)
- `createScheduleTool(config)` — typed `schedule_event` tool for immediate / one-shot / periodic events
- `createTelegraphPublishTool` / `createTelegraphGetTool` / `createTelegraphEditTool` / `createTelegraphListTool`
- `createBotTools(executor)` — convenience bundle of the four core tools (read, bash, edit, write)
- Truncation helpers (`truncateHead`, `truncateTail`)

### Higher-level modules

- `pi-bot-core/agent-settings` — strict loading of shared bot agent tuning, with a separate model context-window override
- `pi-bot-core/agent-extensions` — strict bot `mcp.json` loading plus the per-session Codemode, tool search, and MCP extensions (OAuth via Pi's credential store)
- `pi-bot-core/workspace` — per-chat directory layout (`MEMORY.md`, `attachments/`, `scratch/`, `skills/`), skill loading, host↔container path translation
- `pi-bot-core/workspace-bootstrap` — symlink-aware workspace validation plus seeding and bounded reading of shared `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md` prompt files
- `pi-bot-core/message-log` — append-only `log.jsonl` with the multi-row edit/delete contract used by every bot
- `pi-bot-core/events` — generic event-file watcher that fires immediate / one-shot / periodic JSON events into a dispatcher
- `pi-bot-core/log` — platform-agnostic logger factory (chalk colours, usage summaries, tool/LLM lifecycle lines)
- `pi-bot-core/download-queue` — sequential background downloader for attachments
- `pi-bot-core/fs-watch` — `fs.watch` wrapper that survives macOS inode rotation
- `pi-bot-core/system-prompt` — `buildBaseSystemPrompt` shared scaffold consumed by per-bot system prompts
- `pi-bot-core/telegraph` — in-house Telegraph API client + Markdown ↔ Telegraph node parser/serializer

Immediate events tolerate short outages: files last modified within five minutes before the `EventsWatcher` was constructed (including the cutoff) are dispatched during startup; older files are deleted without dispatch. The existing per-target limit of five in-flight dispatcher calls still applies, and files are deleted before dispatch with no retry on dispatcher failure.

`EventsWatcher.stop()` prevents new dispatch, scheduling, and file side effects from stopped work, including pending reads and parse retries. A restart owns a new lifecycle, so old callbacks and dispatcher cleanup cannot alter its schedules or queue depth. Dispatcher I/O that already began is not cancelled or awaited by `stop()`; it may finish after a restart. The five-call limit is per active lifecycle, not a cap across calls still finishing from a stopped lifecycle. Calling `start()` while already active is a no-op.

## Usage

### Host mode

```ts
import { HostExecutor, createBotTools } from "pi-bot-core";

const executor = new HostExecutor();
const tools = createBotTools(executor);
```

### Docker sandbox mode

```ts
import { DockerExecutor, createBotTools } from "pi-bot-core";

const executor = new DockerExecutor("pi-sandbox");
const tools = createBotTools(executor);
// all bash/read/write/edit now run inside the `pi-sandbox` container
```

### From a CLI flag

```ts
import { parseSandboxArg, validateSandbox, createExecutor, createBotTools } from "pi-bot-core";

// e.g. --sandbox=host  or  --sandbox=docker:pi-sandbox
const config = parseSandboxArg(process.env.SANDBOX ?? "host");
await validateSandbox(config);   // throws SandboxConfigError if docker is missing / container stopped
const tools = createBotTools(createExecutor(config));
```

### Load bot agent settings

```ts
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadAgentSettings } from "pi-bot-core/agent-settings";

const { contextWindow, settings } = loadAgentSettings("config/agent-settings.json");
const settingsManager = SettingsManager.inMemory(settings);
// Apply contextWindow to the resolved model when defined; it is not a Pi setting.
```

`loadAgentSettings(path)` synchronously reads and validates a JSON file with `pi-schema`. It is also exported from `pi-bot-core`. Call it during startup so invalid configuration fails before serving conversations. A valid file looks like:

```json
{
  "contextWindow": 272000,
  "compaction": {
    "reserveTokens": 82000,
    "keepRecentTokens": 20000
  }
}
```

The supported fields are deliberately limited to the tuning shared by the bots:

| Field | Accepted value |
|---|---|
| `contextWindow` | Positive safe integer, at most `Number.MAX_SAFE_INTEGER` |
| `compaction.reserveTokens` | Non-negative safe integer |
| `compaction.keepRecentTokens` | Non-negative safe integer |

All fields are optional, including `compaction` itself. An empty object or partial compaction object leaves omitted values to the caller or SDK defaults. Unknown fields at either level are rejected; this is not a loader for arbitrary Pi `settings.json` files. There is no coercion: numeric strings, booleans, and `null` are invalid. Extend the shared schema explicitly when another setting is needed.

The return value is `{ contextWindow, settings }`, with the bot-owned context window removed from `settings`. Missing or unreadable files and malformed JSON throw instead of falling back to defaults. Schema errors include the file path and JSON Pointer field paths (for example, `/compaction/reserveTokens`); invalid JSON errors do not include file contents. The loader does not write files, log, create a session, or resolve a model. MCP configuration is separate and is not handled by this loader; see [Codemode and MCP](#codemode-and-mcp).

### Codemode and MCP

`pi-bot-core/agent-extensions` builds the SDK extensions a bot's `AgentSession` needs for Codemode and MCP. It is only available from this subpath, so importing `pi-bot-core` does not load this module or `@earendil-works/pi-mcp`. Codemode and the MCP client themselves come from the Pi SDK; this module only configures them.

```ts
import {
  AgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createBotAgentExtensions, loadBotMcpConfig } from "pi-bot-core/agent-extensions";
import { homedir } from "os";
import { join } from "path";

// Startup: invalid config throws before the bot serves chats. A missing file means no servers.
const mcp = loadBotMcpConfig("config/mcp.json");

// Per chat session:
let turnSystemPrompt = "";
const extensions = createBotAgentExtensions({
  name: "telegram",                                   // labels the inline extensions in SDK errors
  mcp,
  mcpLogPath: join(homedir(), ".pi", "pi-telegram-bot", "mcp.log"),
  systemPrompt: () => turnSystemPrompt,               // platform-built prompt for the starting turn
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
  initialActiveToolNames: [...tools.map((tool) => tool.name), ...extensions.activeToolNames],
});
const headlessUi = session.extensionRunner.getUIContext();
await session.bindExtensions({
  uiContext: { ...headlessUi, notify: (message, type) => { /* bot logs warnings and errors */ } },
  onError: (error) => { /* bot logs extension errors */ },
});

// Before each prompt: build the platform prompt, ending with `\n\n## Live State\n...`.
turnSystemPrompt = buildSystemPrompt(/* ... */);
// `prefixedText` is the chat message already prefixed with timestamp and sender, as the
// current bots do; never pass raw user text (a leading `/` would dispatch SDK commands).
await session.prompt(prefixedText);

// Chat teardown, in this order:
await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
await extensions.close();
session.dispose();                                    // when the bot's own run/abort handling allows
```

`createBotAgentExtensions(options)` returns:

- `extensions`: inline extension factories, in order: Codemode (`mode: "on"`, `models: false`); when `mcp` has servers, the SDK tool search extension, a `<name>-mcp-servers` extension registering the configured servers, and the SDK MCP extension; and a hidden `<name>-system-prompt` extension.
- `activeToolNames`: tool names to append to the native tool names in `initialActiveToolNames` (currently `["codemode"]`). Codemode stays active and can batch native tools even with no MCP servers; scripts get no `models` API. The SDK activates `tool_search` itself when a server uses `deferred` exposure.
- `close()`: closes every MCP transport this runtime created, including transports still connecting or reconnecting. It is idempotent and resolves when the closes settle.

Caller contract:

- Create one runtime per chat `AgentSession` and pass `extensions` and `activeToolNames` exactly as above. MCP connections are per chat, not a shared pool; each chat with MCP servers starts its own stdio processes and HTTP sessions.
- The resource loader must disable Pi's own discovery as shown (`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`, empty system prompt overrides). The `<name>-system-prompt` extension forces `systemPrompt()` as the prompt on every `before_agent_start`. When the SDK's MCP extension provides its `mcp_servers` directory (servers with `codemode` or `deferred` tools), it is inserted as `<mcp_servers>…</mcp_servers>` before the last `\n\n## Live State\n` heading, or appended when there is none, so the per-turn state stays at the end.
- Call `session.bindExtensions()`; MCP servers start connecting in the background on `session_start`. Startup problems (failed connections, invalid header or env values, servers needing sign-in) arrive once through `uiContext.notify(message, "warning")` with the SDK's `Run /mcp to fix.` hint, which the bot should rewrite for its operators. Extension handler failures arrive through `onError`.
- On teardown, emit `session_shutdown` first (the SDK MCP extension stops its connections), then `await close()`, then dispose the session. `AgentSession.dispose()` does not emit `session_shutdown` by itself.
- The bot owns the config path and when it is loaded, its platform tools and prompt content, visible filesystem paths, user commands and messages, notification wording, and creation, abort, and disposal of each session.
- The SDK MCP extension registers a `/mcp` command; this module leaves that SDK behavior unchanged. `session.prompt()` dispatches text starting with `/` to extension commands unless `expandPromptTemplates` is `false`, and `/mcp login` would start a browser sign-in on the bot host. Never pass unprefixed chat text that way; the current bots prefix every message with a timestamp and sender.

#### Configuration

`loadBotMcpConfig(path)` reads `{ "mcpServers": { "<name>": { ... } } }`. It is the bot's only MCP source: Pi's personal (`~/.pi/agent/mcp.json`) and project (`.pi/mcp.json`) files are never loaded, and Pi's root-level `autoEnableCodemode` is rejected. Unknown fields anywhere are rejected. Server names may contain only letters, digits, `_`, and `-`, and must stay distinct when `-` is read as `_`.

- stdio: `command`, optional `args`, `env`, `cwd`, and `type: "stdio"`.
- Streamable HTTP: `url` (`http` or `https`), optional `headers`, `oauth`, and `type: "http"` or `"streamable-http"`. Legacy SSE and provider auth (`auth`) are rejected.
- Every server: `description`, `enabled`, `timeout` (positive seconds), `exposure` (`codemode` (default), `codemode-deferred`, `deferred`, `direct`, `hidden`), and `toolExposure` (exact tool names or `*` patterns to an exposure).

Values are validated at load time and resolved in the bot process when a transport is created:

- `env` and `headers` values expand `$NAME` and `${NAME}` from the bot process environment; `$$` gives `$` and `$!` gives `!`. A missing variable fails that server.
- A value starting with `!` runs the rest as a shell command (10 second timeout) and uses its trimmed output. A failure or empty output reports only `command failed`, never the command or its output.
- `~` and `~/` in `command`, `args`, and `cwd` name the bot user's home directory; a relative `cwd` resolves against the session `cwd`.

These are trusted operator settings: commands run with the bot's privileges.

#### OAuth credentials and security boundary

HTTP servers without an `Authorization` header (any capitalization) use the SDK's OAuth credential store, `mcp-auth.json` in Pi's agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). Credentials are selected by server name and URL, so log in on the host with a Pi entry of the same name and URL (`pi mcp login <server>`), and set the same `PI_CODING_AGENT_DIR` for the login and the bot if it is not the default. Stored access tokens are reused, expiring or rejected tokens are refreshed, and rotated tokens are saved back through the SDK's refresh lock, so the directory must be writable. An explicit `Authorization` header always takes precedence over stored OAuth tokens.

MCP connections never start a browser sign-in. Missing or revoked credentials are reported as `<server>: needs sign-in` through `notify`; complete the login on the host. Per the SDK, a session waiting for sign-in reconnects on a later turn once the stored credentials change; restarting the bot also picks them up. Sharing the store does not load personal servers, but it does share authority: every chat that can reach a configured server acts with the logged-in account, not per platform user. Keep tokens out of the bot's `mcp.json` so refreshes do not require editing it.

MCP servers run in the bot process environment, outside any Docker workspace sandbox: stdio servers are host processes with the bot's privileges, and HTTP URLs are resolved from the bot process. Server log notifications are appended to `mcpLogPath`.

#### Bot migration

The Telegram, Discord, and Slack bots still carry their own `mcp.ts` and session wiring; moving them to this module is a separate change per bot. This module follows the Telegram `wip/mcp-oauth` behavior, so bots that still reject `oauth` and disable the credential store will start accepting OAuth settings and using stored credentials when they migrate.

### Workspace bootstrap files

```ts
import {
  ensureWorkspaceBootstrap,
  ensureWorkspacePathIsSafe,
  readWorkspaceBootstrap,
  WorkspaceBootstrapSecurityError,
} from "pi-bot-core/workspace-bootstrap";

// Startup: validate before any other workspace storage I/O, then seed.
ensureWorkspacePathIsSafe(workspace);
ensureWorkspaceBootstrap(workspace);

// Every run: revalidate, then read fresh content for the system prompt.
ensureWorkspacePathIsSafe(workspace);
const workspaceBootstrap = readWorkspaceBootstrap(workspace, visibleWorkspacePath);
```

This module is only available from the `pi-bot-core/workspace-bootstrap` subpath. It does not change `ensureChatDir` or other `pi-bot-core/workspace` behavior.

Caller contract:

- `ensureWorkspacePathIsSafe(workspace)` throws `WorkspaceBootstrapSecurityError` when `fs.constants.O_NOFOLLOW` is unavailable (checked before any filesystem access) or when the workspace or any parent is a symbolic link or non-directory. Otherwise it creates missing directories. Call it before creating any workspace storage and again before each run.
- `ensureWorkspaceBootstrap(workspace)` creates missing starter files at the workspace root with exclusive create, so existing files (including dangling links) are never overwritten. It does nothing if the workspace is missing or linked, and stops if the workspace path changes between files.
- `readWorkspaceBootstrap(workspace, visibleWorkspace)` returns `### <visibleWorkspace>/<file>` headings with `<agents_md>`, `<soul_md>`, `<identity_md>`, and `<user_md>` sections, separated by blank lines. Content is trimmed. Missing, linked, or non-regular files, and a missing or changed workspace path, produce empty sections. `AGENTS.md`, `SOUL.md`, and `IDENTITY.md` are limited to 20,000 Unicode code points and `USER.md` to 4,000; longer content ends with `[truncated: read <visibleWorkspace>/<file> for the rest]`. It throws `WorkspaceBootstrapSecurityError` when `O_NOFOLLOW` is unavailable.
- Unexpected filesystem errors (for example `EACCES`) are thrown by all three functions.
- `USER.md` lives at the workspace root and is shared by every chat using that workspace. Files are reread on every call, so edits apply to the next run.
- Where the section goes in the system prompt, which visible path to show (for example `/workspace` in Docker mode), how errors are presented to users, and when these functions are called are decided by each bot.

Limitations: the checks compare each path component's device and inode before and after operations and open files with `O_NOFOLLOW`, but they are not atomic. A process that can modify the workspace or its parents can still race the checks. This reduces accidental or casual symlink escapes; it is not a filesystem sandbox.

### Pick tools individually

```ts
import { HostExecutor, createBashTool, createReadTool } from "pi-bot-core";

const executor = new HostExecutor();
const tools = [createBashTool(executor), createReadTool(executor)];
```

### Add platform-specific tools

```ts
import {
  createBotTools,
  createAttachTool,
  createChatHistoryTool,
  createScheduleTool,
} from "pi-bot-core";

const tools = [
  ...createBotTools(executor),
  createAttachTool().tool,                          // wire setUploader at run time
  createChatHistoryTool({ logFilePath }),
  createScheduleTool(scheduleConfig),               // bot supplies routing schema
];
```

## Sandbox: division of responsibilities

What this package owns:

- `Executor` interface + host/docker implementations
- `SandboxConfig` + parse/validate/create helpers

What each bot repo owns:

- Wiring the CLI flag / env var to `parseSandboxArg`
- Container lifecycle scripts (`docker.sh` / Makefile / Dockerfile)
- System-prompt wording that tells the LLM whether it's on host or in a container
  (paths, package manager, etc. — see each bot's `buildSystemPrompt`)

## Runtime requirements

Consumers must provide `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-mcp` matching the `^1.5.0` peer dependency ranges. Development installs use the same SDK range.

Tool parameter schemas use `@earendil-works/pi-schema` instead of a direct TypeBox dependency. Built-in schemas use `obj(properties, { open: true })` to preserve their acceptance of extra fields; required fields, optional fields, descriptions, and numeric bounds are unchanged. Pi SDK 1.5 validates and coerces tool arguments with pi-schema, including its validation error messages. `pi-coding-agent` still brings TypeBox as a transitive dependency for extension compatibility.

When supplying `createScheduleTool` parameters, use pi-schema builders (`obj`, `str`, `num`, `opt`, etc.); routing callback arguments are inferred with pi-schema's `Static`. Unlike the built-in schemas here, `obj(properties)` is closed by default; pass `{ open: true }` if your schema should accept extra fields.

### Host mode

- Node/Bun with `sh` (POSIX) or `cmd` (Windows) on the host.

### Docker mode

- `docker` CLI available on the host `PATH`
- A running container with at least `/bin/sh` (Alpine works; no `bash` needed)
- Workspace mounted into the container, conventionally at `/workspace`
  (`DockerExecutor.getWorkspacePath()` always returns `/workspace`)

Example one-liner to create a throwaway Alpine container:

```bash
docker run -d --name pi-sandbox \
  -v "$(pwd)/data:/workspace" \
  alpine:latest tail -f /dev/null
```

No new npm dependency for sandboxing — `DockerExecutor` is string wrapping around `docker exec` and reuses `HostExecutor` for the actual child-process work.

## Development

```sh
bun install
bun run typecheck
bun test
```

`typecheck` also checks `tests/tool-schemas.test.ts` so schedule routing argument inference is covered in CI, as well as the event lifecycle and shared system-prompt tests, the Codemode/MCP tests, and their fixtures.

The Codemode/MCP tests run real stdio and streamable HTTP fixture servers and a local OAuth server, with `HOME`, `PI_CODING_AGENT_DIR`, credential, and log paths in temporary directories. They drive tool calls through the SDK tool pipeline with synthetic assistant messages and never call a model.

No build step — consumers import `src/*.ts` directly (Bun / tsc bundler mode). Subpath exports in `package.json` map each module to its source file.
