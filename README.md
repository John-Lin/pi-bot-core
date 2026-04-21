# pi-bot-tools

Shared agent tools for pi-mono based bots (e.g. `pi-discord-bot`, `pi-telegram-bot`).

Ported from [`pi-mono/packages/mom`](https://github.com/badlogic/pi-mono/tree/main/packages/mom) with the `Executor` abstraction so the same tools work on host or (future) Docker/remote sandboxes.

## Contents

- `Executor` interface + `HostExecutor` (runs commands locally via `sh -c`)
- `createBashTool(executor)` — run bash commands with tail truncation + temp file spill
- `createReadTool(executor)` — read text files (with offset/limit) and images (base64)
- `createWriteTool(executor)` — write files, creates parent dirs
- `createEditTool(executor)` — exact-match text replacement with unified diff output
- Truncation helpers (`truncateHead`, `truncateTail`)

All tools are `AgentTool` instances from `@mariozechner/pi-agent-core` so they drop into any Agent session.

## Usage

```ts
import { HostExecutor, createBotTools } from "pi-bot-tools";

const executor = new HostExecutor();
const tools = createBotTools(executor);

// pass `tools` to your agent session
```

Or pick tools individually:

```ts
import { HostExecutor, createBashTool, createReadTool } from "pi-bot-tools";

const executor = new HostExecutor();
const tools = [createBashTool(executor), createReadTool(executor)];
```

## Status

- [x] `HostExecutor`
- [ ] `DockerExecutor` (planned — see below)
- [x] bash / read / write / edit
- [ ] grep / find / ls (agent uses bash for now, same as pi-mom)

## Roadmap: sandbox support

Planned, modelled on `pi-mono/packages/mom/src/sandbox.ts`:

```ts
// pi-bot-tools additions
export type SandboxConfig =
  | { type: "host" }
  | { type: "docker"; container: string };

export function createExecutor(config: SandboxConfig): Executor;

export class DockerExecutor implements Executor {
  constructor(container: string);
  // wraps command in `docker exec <container> sh -c '<cmd>'`
  // and delegates to an internal HostExecutor
  // getWorkspacePath() → "/workspace"
}
```

What stays outside this package (each bot repo owns):

- CLI flag parsing (e.g. `--sandbox=docker:<name>`) and validation
- Container lifecycle scripts (`docker.sh` / Makefile / Dockerfile)
- System-prompt wording that tells the LLM whether it's on host or in a container
  (paths, package manager, etc. — see `pi-mom/src/agent.ts buildSystemPrompt`)

Runtime requirements (when `DockerExecutor` is used):

- `docker` CLI available on the host `PATH`
- A running container with at least `/bin/sh` (Alpine works; no `bash` needed)
- Desired workspace mounted into the container (conventionally `/workspace`)

No new npm dependency is planned — `DockerExecutor` is string wrapping + reuse of `HostExecutor`.

## Development

```sh
bun install
bun run typecheck
```

No build step — consumers import `src/*.ts` directly (Bun / tsc bundler mode).
