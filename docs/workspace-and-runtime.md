# Workspace and runtime modules reference

This reference covers the workspace, tool, event, logging, prompt, and utility modules exported by `pi-bot-core`. For VM sandbox and MCP extension references, see [VM sandbox reference](vm-sandbox.md) and [Agent settings and MCP extensions reference](agent-extensions.md).

## `pi-bot-core/workspace`

This module manages per-chat directory layouts, memory reads, and skill discovery:

- `ensureChatDir(workspace: string, chatId: number | string): ChatPaths` validates `workspace` and `chatId` and checks all target directory components for symbolic links and non-directories. It then creates `<workspace>/{MEMORY.md, skills/}` and `<workspace>/<chatId>/{MEMORY.md, attachments/, scratch/, skills/}`, and returns `ChatPaths` (`workspace`, `chatDir`, `memoryFile`, `contextFile`, `skillsDir`, `scratchDir`, `attachmentsDir`).
  - `chatId` must be a single directory name containing only ASCII letters, digits, `-`, `_`, or `.`.
  - `chatId` cannot be empty, `.`, `..`, or match `MEMORY.md` or `skills` in any case. Invalid values throw `WorkspaceBootstrapSecurityError`.
- `readMemory(paths: ChatPaths): string` reads `<workspace>/MEMORY.md` and `<chatDir>/MEMORY.md`, wraps non-empty content in `<global_memory>` and `<chat_memory>` tags, or returns `"(no working memory yet)"`. Each file opens without following links, omits unsafe entries, and truncates at 80,000 bytes.
- `loadChatSkills(paths: ChatPaths, guestWorkspace?: string): Skill[]` loads skills from `<workspace>/skills` and then `<chatDir>/skills`, letting chat skills override workspace skills on name collision. When `guestWorkspace` is provided, it rewrites `filePath` and `baseDir` so workspace tools can open them inside the VM. Preflight skips an entire scope if it detects unsafe entries or any `.md`, `.gitignore`, `.ignore`, or `.fdignore` file larger than 1 MiB. Because the Pi skill loader opens files after preflight, do not let another host process replace skill directories while the bot runs.

## `pi-bot-core/workspace-bootstrap`

This module validates workspace root safety and manages shared `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md` prompt files at the workspace root:

- `ensureWorkspacePathIsSafe(workspace: string): void` and `ensureWorkspaceDirectoriesAreSafe(directories: readonly string[]): void` throw `WorkspaceBootstrapSecurityError` when `fs.constants.O_NOFOLLOW` is unavailable or when a directory or any parent component is a symbolic link or non-directory. Missing directories are created and re-verified afterward. Call `ensureWorkspacePathIsSafe` before other workspace storage I/O and again before every run.
- `ensureWorkspaceBootstrap(workspace: string): void` creates missing starter files with exclusive creation (`wx`), so existing files and dangling links are never overwritten. It does nothing if the workspace is missing or linked, and stops if workspace path identity changes between files.
- `readWorkspaceBootstrap(workspace: string, visibleWorkspace?: string): string` rereads the four bootstrap files on every call and returns `<agents_md>`, `<soul_md>`, `<identity_md>`, and `<user_md>` sections separated by blank lines.
  - Content is trimmed. Missing, linked, or non-regular files and a missing or changed workspace path produce empty sections.
  - `AGENTS.md`, `SOUL.md`, and `IDENTITY.md` cap at 20,000 Unicode code points. `USER.md` caps at 4,000 Unicode code points and is shared across every chat using that workspace.
  - Truncated files end with `[host-managed file truncated]`, or `[truncated: read <visibleWorkspace>/<name> for the rest]` when `visibleWorkspace` is passed. Omit `visibleWorkspace` when using `VMSandbox` because bootstrap files stay on the host and are not mounted in the VM.
  - Throws `WorkspaceBootstrapSecurityError` when `O_NOFOLLOW` is unavailable.
- All three functions propagate unexpected filesystem errors such as `EACCES`.

**Limitation.** Path checks compare each component's device and inode before and after operations and open files with `O_NOFOLLOW`, but these steps are not atomic. Another host process that can modify the workspace or its parent directories can still race the checks. This mechanism guards against accidental symlink escapes and is not a filesystem sandbox.

## `pi-bot-core/tools`

Also re-exported from `pi-bot-core`. All tools return `AgentTool` instances from `@earendil-works/pi-agent-core`.

### Built-in tools and helpers

| Export | Purpose |
| --- | --- |
| `createBotTools(executor)` | Returns `[read, bash, edit, write]` bound to `executor` |
| `createBashTool(executor)` | Executes bash commands with tail truncation and optional spill file via `executor.saveOutput` |
| `createReadTool(executor)` | Reads text files (`offset` and `limit`, head-truncated) and images (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` as base64) |
| `createWriteTool(executor)` | Creates or overwrites files and creates missing parent directories |
| `createEditTool(executor)` | Performs unique exact-match text replacement and returns a unified diff in `details.diff` |
| `createAttachTool()` | Returns `{ tool, setUploader }` so each chat run injects its own uploader callback without a module singleton |
| `createChatHistoryTool({ logFilePath })` | Searches `log.jsonl` by query and ISO 8601 date bounds (`after`, `before`, `limit` default 20, max 200) |
| `createScheduleTool(config)` | Exposes `schedule_event` to validate and atomically write event JSON files to `<workspace>/events/` |
| `buildEventPayload(args, now?)` | Validates common schedule fields and builds `{ filename, json }` directly |
| `createTelegraphPublishTool(workspace, defaults)` | Publishes Markdown to Telegraph and provisions `<workspace>/.telegraph.json` on first use |
| `createTelegraphGetTool()` | Fetches a Telegraph URL or path and returns Markdown |
| `createTelegraphEditTool(workspace)` | Overwrites title and body of a Telegraph page authored by the workspace account |
| `createTelegraphListTool(workspace)` | Lists published Telegraph pages (`offset` default 0, `limit` default 50, max 200) |
| `truncateHead`, `truncateTail`, `formatSize` | Shared truncation helpers defaulting to `DEFAULT_MAX_LINES` (`2000`) and `DEFAULT_MAX_BYTES` (`51200`, 50 KiB) |

### Tool schemas and behavior details

Individual tools follow these schema and runtime rules:

- **Schemas.** Built-in tools define schemas with `@earendil-works/pi-schema` using `obj(properties, { open: true })` so extra fields are accepted. When passing `parameters` to `createScheduleTool`, use `pi-schema` builders (`obj`, `str`, `num`, `opt`). `Static<TParams>` types `buildRouting(args)`. Because `obj(properties)` is closed by default, pass `{ open: true }` if your schedule tool should accept extra fields. Defining `label` is optional for scheduling.
- **`attach`.** Rejects relative paths before calling the uploader. Resolves `fileName` from `title` when provided (preserving the extension from `path` if `title` omits one) or `basename(path)`. Wire the uploader through `turn.readAttachment(path)` and clear it with `setUploader(null)` in `finally`.
- **`chat_history`.** Reads `log.jsonl` on demand through `parseMessageLogEntry`. It honors edits and deletion tombstones, ignores malformed rows, and appends a `<system-reminder>` fence marking returned history as reference data only.
- **`schedule_event`.** Validates `immediate`, `one-shot` (future ISO 8601 `at`), and `periodic` (recurring cron with an IANA timezone name, rejecting UTC offsets) schedules. It validates `name` against `/^[a-z0-9-]{1,40}$/` and writes `<slug>-<timestamp>.json` atomically through a `.tmp` file.

## `pi-bot-core/events`

`EventsWatcher<TEvent>` and `createEventsWatcher(workspaceDir, dispatcher, policy)` watch `<eventsDir>/*.json` and dispatch scheduled events through a caller-supplied `EventsPolicy<TEvent>` (`parse`, `queueKey`, and optional `log`).

Event types and timing rules:

- **`immediate`.** Dispatches when detected and deletes the file before calling the dispatcher. On startup, files modified within 5 minutes before `EventsWatcher` construction (inclusive of the cutoff) are dispatched. Older files are deleted without dispatch.
- **`one-shot`.** Schedules a timer for ISO 8601 `at` (re-arming timers for delays exceeding 32-bit timer limits) and deletes the file before dispatch. Past or invalid `at` files are deleted without dispatch.
- **`periodic`.** Schedules a `croner` job using `schedule` and IANA `timezone`. Files persist on disk until deleted externally.
- **Read retries and delivery.** Mid-write reads retry up to 3 times with exponential backoff (starting at 100 ms) before deleting an unparseable file. Delivered events pass a `FiredEvent` whose `text` is prefixed with `[EVENT:<filename>:<type>:<scheduleInfo>] <original text>`.
- **Queue depth.** At most 5 in-flight dispatcher calls are allowed per `policy.queueKey(event)`. Additional events for a full bucket are discarded (and immediate or one-shot files are deleted). Dispatcher failures are logged with no retry.

Policy callback rules:

- **`parse`.** Throw an `Error` for invalid contents. The watcher retries, then logs a warning and deletes the file.
- **`queueKey` and `log`.** Must not throw. The watcher does not catch their errors, so a thrown error becomes an unhandled rejection. By default, Bun ends the process on an unhandled rejection.

Lifecycle rules:

- Calling `start()` while already active is a no-op.
- `stop()` prevents new dispatch, scheduling, and file side effects from stopped work, including pending file reads and parse retries.
- Restarting creates a new lifecycle generation so stale callbacks and dispatcher cleanup from an older lifecycle cannot alter schedules or queue depth.
- Dispatcher I/O that already started is neither cancelled nor awaited by `stop()`, and may finish after a restart. The 5-call limit applies per active lifecycle.

## `pi-bot-core/message-log`

`MessageLog` writes append-only JSONL logs to `<workingDir>/<id>/log.jsonl` and exposes `parseMessageLogEntry` for reading them:

- `logMessage(id, message, opts?)` appends a `LoggedMessage` line, stamping current ISO time if `date` is empty, and deduplicates identical `<id>:<ts>` keys for 60 seconds in memory. Pass `{ force: true }` to append edit rows (`editedAt`) or deletion tombstones (`isDeleted: true`).
- `logBotResponse(id, text, ts)` logs the bot's own outgoing message with `user: "bot"` and `isBot: true`.
- `getLastTimestamp(id)` returns the `ts` of the last line or `null` when missing or unreadable.
- `parseMessageLogEntry(line)` validates a single JSONL line into `{ kind: "message", ts, date, text, speaker }` or `{ kind: "deleted", ts }`, or returns `undefined` for malformed lines.
- **Multi-row contract.** Consumers treat the last valid row for a given `ts` as authoritative and omit any `ts` whose last valid row has `isDeleted: true`. Readers ignore malformed rows so a corrupt edit cannot replace a valid message. A valid deletion tombstone suppresses its message even when display metadata is missing or invalid.

## `pi-bot-core/system-prompt`

Also re-exported from `pi-bot-core`. `buildBaseSystemPrompt(input: BaseSystemPromptInput)` generates the shared system prompt from a `PlatformConfig` and per-turn state.

- Pass `WORKSPACE_GUEST_ROOT` from `pi-bot-core/vm-sandbox` as `workspacePath`.
- Pass the same `writableWorkspaceContent` boolean used in `VMSandboxOptions` so the prompt reflects actual guest mount permissions.
- Put per-turn values only in `liveStateLines`. `buildBaseSystemPrompt` places `## Live State` at the end so the prompt prefix stays stable for prompt caching across turns.

## `pi-bot-core/telegraph`

This module provides the Telegraph (`api.telegra.ph`) client, workspace account storage, and Markdown converter:

- `ensureTelegraphAccount(workspace, defaults)` loads `<workspace>/.telegraph.json` or creates a new Telegraph account on first use.
- `createAccount`, `createPage`, `editPage`, `getPage`, and `getPages` validate API responses and stored account files with `pi-schema` without fabricating missing metadata. At runtime, API responses can omit `auth_url` or page `content`, and copied `.telegraph.json` files can contain only `access_token`.
- `parse(markdown)` and `serialize(nodes)` convert between Markdown and Telegraph `Node[]` trees (`SUPPORTED_TAGS`). `parse` downgrades `h1` and `h2` headings to `h3`, maps deeper headings to `h4`, converts standalone image paragraphs to `<figure>`, and drops tables and raw HTML.

## `pi-bot-core/log`, `pi-bot-core/download-queue`, and `pi-bot-core/fs-watch`

These utility modules handle logging, background downloads, and resilient file watching:

- **`pi-bot-core/log`.** `createLogger<TLogContext>({ formatContext, writeLine?, formatBold? })` returns a plain object of standalone logging functions (user messages, tool start and completion, LLM calls, downloads, warnings, errors, and formatted `logUsageSummary`). `writeLine` defaults to stdout and `formatBold` defaults to `**text**`.
- **`pi-bot-core/download-queue`.** `new DownloadQueue({ workingDir, downloadFile, log })` drains enqueued `DownloadItem` entries sequentially in FIFO order. Call `enqueue(item)` to schedule downloads and `await waitForDownloads()` to wait until the queue drains.
- **`pi-bot-core/fs-watch`.** `watchWithErrorHandler(path, listener, onError)` wraps `node:fs` `watch()` so callers can detect watcher errors (such as macOS inode rotation), close with `closeWatcher(watcher)`, and retry after `FS_WATCH_RETRY_DELAY_MS` (`5000` ms).
