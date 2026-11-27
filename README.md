# pi-bot-core

Shared runtime and building blocks for Pi SDK bots such as `pi-discord-bot` and `pi-telegram-bot`.

Workspace tools run in a per-turn Linux VM through Gondolin and the `Executor` interface. Consumers import `src/*.ts` directly through the `exports` map in `package.json` using Bun or TypeScript bundler mode, with no build step.

Some modules were originally ported from [pi-mono](https://github.com/badlogic/pi-mono) (`pi-mono/packages/mom`) and remain MIT-licensed under the original copyright. See [LICENSE](LICENSE).

## Documentation

Read these guides and references by task or module.

| Document | Mode | Topics |
| --- | --- | --- |
| [Integrate a bot](docs/integrate-a-bot.md) | How-to | Startup checks, per-chat sessions, per-turn VM sandboxes, tools, progress reporting, and teardown |
| [VM sandbox reference](docs/vm-sandbox.md) | Reference | `Executor`, `VMSandbox`, `VMSandboxTurn`, QEMU and krun requirements, mount permissions, and web secrets |
| [Agent settings and MCP extensions reference](docs/agent-extensions.md) | Reference | `loadAgentSettings`, `loadBotMcpConfig`, `createBotAgentExtensions`, OAuth credentials, and session contracts |
| [Progress tracker reference](docs/progress.md) | Reference | `ProgressTracker`, `ProgressEvent`, row limits, rendering rules, text escaping, and memory retention |
| [Workspace and runtime modules reference](docs/workspace-and-runtime.md) | Reference | Workspace layout, bootstrap files, tools, event watcher, message log, system prompt, Telegraph, logger, download queue, and file watching |

## Requirements

Consumers must provide the following peer dependencies matching `^1.5.0`:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-mcp`

Tool schemas and runtime validators use `@earendil-works/pi-schema`.

The VM sandbox requires macOS or Linux on arm64 or x64, `qemu-img`, `tar` with gzip support, and a configured backend runner. See [VM sandbox reference](docs/vm-sandbox.md#host-requirements) for QEMU and krun host requirements.

## Package exports

The `exports` map in `package.json` defines 16 entrypoints. Run `node -e 'console.log(Object.keys(require("./package.json").exports).join("\n"))'` to regenerate the list.

| Subpath | Source | Also in `pi-bot-core` | Purpose |
| --- | --- | --- | --- |
| `pi-bot-core` | `src/index.ts` | Yes | Re-exports `sandbox`, `agent-settings`, `system-prompt`, and `tools` |
| `pi-bot-core/sandbox` | `src/sandbox.ts` | Yes | `Executor`, `ExecOptions`, `ExecResult`, and `SandboxConfigError` |
| `pi-bot-core/vm-sandbox` | `src/vm-sandbox.ts` | No | `validateVMSandbox`, `VMSandbox`, `VMSandboxTurn`, and web secret scoping |
| `pi-bot-core/agent-settings` | `src/agent-settings.ts` | Yes | Strict loader for bot `agent-settings.json` |
| `pi-bot-core/agent-extensions` | `src/agent-extensions.ts` | No | Strict `mcp.json` loader and per-session Codemode and MCP extensions |
| `pi-bot-core/tools` | `src/tools/index.ts` | Yes | Workspace, attachment, chat history, schedule, and Telegraph tools plus truncation helpers |
| `pi-bot-core/workspace` | `src/workspace.ts` | No | Per-chat directory layout, bounded memory reads, and skill loading |
| `pi-bot-core/workspace-bootstrap` | `src/workspace-bootstrap.ts` | No | Symlink-safe path checks, seeding, and bounded reading of shared prompt files |
| `pi-bot-core/events` | `src/events.ts` | No | Directory watcher for immediate, one-shot, and periodic JSON events |
| `pi-bot-core/message-log` | `src/message-log.ts` | No | Append-only `log.jsonl` writer and reader with edit and deletion tombstones |
| `pi-bot-core/progress` | `src/progress.ts` | No | Platform-independent per-run tool progress tracker and plain-text renderer |
| `pi-bot-core/system-prompt` | `src/system-prompt.ts` | Yes | `buildBaseSystemPrompt` shared system prompt builder |
| `pi-bot-core/telegraph` | `src/telegraph/index.ts` | No | Telegraph API client, account storage, and Markdown converter |
| `pi-bot-core/log` | `src/log.ts` | No | Platform-agnostic logger factory with formatted usage summaries |
| `pi-bot-core/download-queue` | `src/download-queue.ts` | No | Sequential FIFO background downloader for attachments |
| `pi-bot-core/fs-watch` | `src/fs-watch.ts` | No | `fs.watch` error wrapper for macOS inode rotation |

## Development

Install dependencies and run linting, typechecking, and unit tests with `--no-env-file` so local `.env` files do not affect runs:

```sh
bun --no-env-file install --frozen-lockfile
bun --no-env-file run lint
bun --no-env-file run typecheck
bun test --no-env-file
```

The `typecheck` script checks all TypeScript files under `src/` and `tests/`. The `lint` script runs `oxlint` on `src/` and fails on unused `oxlint-disable` directives.

### Pre-commit hooks

Install [prek](https://github.com/j178/prek) (for example, run `brew install prek` on macOS), then enable hooks once per clone after installing dependencies:

```sh
prek install
```

On every commit, `prek` runs `bun --no-env-file run typecheck`, runs `oxlint` on staged TypeScript files under `src/`, and checks staged files for merge conflict markers and private keys. The hooks do not rewrite files. Run `prek run --all-files` to check the entire repository manually.

### Integration and VM tests

The Codemode and MCP tests run real stdio, streamable HTTP, and local OAuth fixture servers using temporary `HOME` and `PI_CODING_AGENT_DIR` directories. These tests drive the SDK tool pipeline with synthetic assistant messages and never call a model.

Real-VM tests are skipped by default during `bun test`. Before running them locally, cache the pinned VM image for your target backend:

```sh
bun --no-env-file -e 'import { validateVMSandbox } from "pi-bot-core/vm-sandbox"; await validateVMSandbox();'
```

To prepare the `krun` backend instead, pass `{ backend: "krun" }` to `validateVMSandbox`.

Run the opt-in VM test suites with these commands.

| Suite | Command |
| --- | --- |
| QEMU VM suite (also run in CI) | `PI_BOT_TEST_VM_SANDBOX=1 bun test --no-env-file tests/vm-sandbox.test.ts` |
| Public HTTPS test against `example.com` | `PI_BOT_TEST_VM_SANDBOX_WEB=1 bun test --no-env-file tests/vm-sandbox.test.ts` |
| krun VM suite on a supported host | `PI_BOT_TEST_VM_SANDBOX_KRUN=1 bun test --no-env-file tests/vm-sandbox.test.ts -t krun` |
