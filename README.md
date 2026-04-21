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
- [ ] `DockerExecutor` (planned)
- [x] bash / read / write / edit
- [ ] grep / find / ls (agent uses bash for now, same as pi-mom)

## Development

```sh
bun install
bun run typecheck
```

No build step — consumers import `src/*.ts` directly (Bun / tsc bundler mode).
