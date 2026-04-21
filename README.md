# pi-bot-tools

Shared agent tools for pi-mono based bots (e.g. `pi-discord-bot`, `pi-telegram-bot`).

Ported from [`pi-mono/packages/mom`](https://github.com/badlogic/pi-mono/tree/main/packages/mom) with the `Executor` abstraction so the same tools work on host or inside a Docker container without tool changes.

## Contents

- `Executor` interface
- `HostExecutor` — runs commands locally via `sh -c`
- `DockerExecutor` — runs commands inside a running container via `docker exec ... sh -c`
- `createExecutor(config)` / `parseSandboxArg(arg)` / `validateSandbox(config)` helpers
- `createBashTool(executor)` — run bash with tail truncation + temp file spill
- `createReadTool(executor)` — read text files (offset/limit) and images (base64)
- `createWriteTool(executor)` — write files, creates parent dirs
- `createEditTool(executor)` — exact-match text replacement with unified diff output
- Truncation helpers (`truncateHead`, `truncateTail`)

All tools are `AgentTool` instances from `@mariozechner/pi-agent-core` so they drop into any Agent session.

## Usage

### Host mode

```ts
import { HostExecutor, createBotTools } from "pi-bot-tools";

const executor = new HostExecutor();
const tools = createBotTools(executor);
```

### Docker sandbox mode

```ts
import { DockerExecutor, createBotTools } from "pi-bot-tools";

const executor = new DockerExecutor("pi-sandbox");
const tools = createBotTools(executor);
// all bash/read/write/edit now run inside the `pi-sandbox` container
```

### From a CLI flag

```ts
import { parseSandboxArg, validateSandbox, createExecutor, createBotTools } from "pi-bot-tools";

// e.g. --sandbox=host  or  --sandbox=docker:pi-sandbox
const config = parseSandboxArg(process.env.SANDBOX ?? "host");
await validateSandbox(config);   // throws SandboxConfigError if docker is missing / container stopped
const tools = createBotTools(createExecutor(config));
```

### Pick tools individually

```ts
import { HostExecutor, createBashTool, createReadTool } from "pi-bot-tools";

const executor = new HostExecutor();
const tools = [createBashTool(executor), createReadTool(executor)];
```

## Status

- [x] `HostExecutor`
- [x] `DockerExecutor`
- [x] `SandboxConfig` / `parseSandboxArg` / `validateSandbox` / `createExecutor`
- [x] bash / read / write / edit
- [ ] grep / find / ls (agent uses bash for now, same as pi-mom)

## Sandbox: division of responsibilities

What this package owns:

- `Executor` interface + host/docker implementations
- `SandboxConfig` + parse/validate/create helpers

What each bot repo owns:

- Wiring the CLI flag / env var to `parseSandboxArg`
- Container lifecycle scripts (`docker.sh` / Makefile / Dockerfile)
- System-prompt wording that tells the LLM whether it's on host or in a container
  (paths, package manager, etc. — see `pi-mom/src/agent.ts buildSystemPrompt`)

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

No new npm dependency — `DockerExecutor` is string wrapping around `docker exec` and reuses `HostExecutor` for the actual child-process work.

## Development

```sh
bun install
bun run typecheck
```

No build step — consumers import `src/*.ts` directly (Bun / tsc bundler mode).
