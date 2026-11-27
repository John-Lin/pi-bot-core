# AGENTS.md

Shared runtime for Pi SDK bots. There is no build step: consumers import `src/*.ts` through the `package.json` `exports` map and pin a git tag (`github:John-Lin/pi-bot-core#vX.Y.Z`).

## Public API contract

- Every module behind `exports` is a contract with the consumer bots: keep exported names, types, and runtime shapes compatible.
- Adding, removing, or renaming an entrypoint means updating both `exports` and the README "Package exports" table.
- Public behavior changes go into the matching reference doc in the same change:
  - `docs/vm-sandbox.md`: `Executor`, `VMSandbox`, host requirements, mounts, network policy, web secrets.
  - `docs/agent-extensions.md`: `agent-settings.json`, `mcp.json`, Codemode and MCP extensions, OAuth credentials.
  - `docs/progress.md`: `ProgressTracker` events and rendering.
  - `docs/workspace-and-runtime.md`: workspace layout, bootstrap, tools, events, message log, system prompt, Telegraph, logger.
  - `docs/integrate-a-bot.md`: how consumers wire sessions and turns; read it before changing session or turn lifecycle.

## TypeScript

- `exactOptionalPropertyTypes` is on. Omit absent optional fields instead of passing `undefined`; when a repo-owned field really carries `undefined` to mean absent, declare it `prop?: T | undefined`.
- Lint covers `src/` only and rejects `any`, `!`, `as` assertions, and `console`. Narrow unknown data with `@earendil-works/pi-schema` `compile` validators or type guards.

## Dependencies

- The `@earendil-works/pi-*` SDK packages appear in both `peerDependencies` and `devDependencies` because bun keeps peer-only packages stuck at the installed version. Edit the ranges, then `bun --no-env-file install`.
- The two ranges mean different things: `devDependencies` is the SDK version core is verified against; `peerDependencies` is the minimum SDK core requires from consumers. To verify against a newer SDK, bump only the dev range. Raise the peer range only when core starts using an API the old minimum lacks, and update the README consumer requirement with it.
- After changing any workflow `uses:`, run `gh actions-lock` and commit `.github/workflows/actions.lock` with it; CI fails when the lockfile is out of sync.

## Tests

Tests exercise real behavior. Tool tests run real shell commands through `tests/helpers/host-executor.ts`; SDK, Codemode, and MCP tests use `tests/helpers/bot-session.ts` with the fixture servers in `tests/fixtures/` and an isolated `HOME`, and never call a model. Build new tests on these helpers.

## Verification

Run before finishing; everything must pass. `--no-env-file` keeps a local `.env` out of every run.

```sh
prek run --all-files     # typecheck, lint, actionlint, repo checks (same hooks as CI)
bun test --no-env-file   # unit and MCP integration tests; real-VM tests skip
```

For changes to the VM sandbox, web secrets, or how tools execute through the `Executor`, also run the QEMU suite that CI runs:

```sh
bun --no-env-file -e 'import { validateVMSandbox } from "pi-bot-core/vm-sandbox"; await validateVMSandbox();'  # caches the VM image
PI_BOT_TEST_VM_SANDBOX=1 bun test --no-env-file tests/vm-sandbox.test.ts
```

krun and public-HTTPS suites: see README "Integration and VM tests".

## Git

- Conventional Commits scoped to the module (`fix(telegraph): ...`, `refactor(tools): ...`). Work lands through `wip/<topic>` branches and pull requests to `main`.
- A release is a `chore(release): bump core to X.Y.Z` commit that changes only `package.json` `version`, tagged `vX.Y.Z`.
