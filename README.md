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

All tools are `AgentTool` instances from `@mariozechner/pi-agent-core` and drop into any Agent session.

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

- `pi-bot-core/workspace` — per-chat directory layout (`MEMORY.md`, `attachments/`, `scratch/`, `skills/`), skill loading, host↔container path translation
- `pi-bot-core/message-log` — append-only `log.jsonl` with the multi-row edit/delete contract used by every bot
- `pi-bot-core/events` — generic event-file watcher that fires immediate / one-shot / periodic JSON events into a dispatcher
- `pi-bot-core/log` — platform-agnostic logger factory (chalk colours, usage summaries, tool/LLM lifecycle lines)
- `pi-bot-core/download-queue` — sequential background downloader for attachments
- `pi-bot-core/fs-watch` — `fs.watch` wrapper that survives macOS inode rotation
- `pi-bot-core/system-prompt` — `buildBaseSystemPrompt` shared scaffold consumed by per-bot system prompts
- `pi-bot-core/telegraph` — in-house Telegraph API client + Markdown ↔ Telegraph node parser/serializer

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

No build step — consumers import `src/*.ts` directly (Bun / tsc bundler mode). Subpath exports in `package.json` map each module to its source file.
