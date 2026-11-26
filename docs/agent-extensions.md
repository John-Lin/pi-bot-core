# Agent settings and MCP extensions reference

This reference covers `pi-bot-core/agent-settings` (also re-exported from `pi-bot-core`) and `pi-bot-core/agent-extensions` (subpath-only). Importing `pi-bot-core` does not load `pi-bot-core/agent-extensions` or `@earendil-works/pi-mcp`. For integration steps, see [Integrate a bot](integrate-a-bot.md).

## `pi-bot-core/agent-settings`

`loadAgentSettings(path: string)` synchronously reads and validates a bot `agent-settings.json` file with `pi-schema`. Call it during startup so invalid configuration fails before the bot serves chats.

Example configuration:

```json
{
	"contextWindow": 272000,
	"compaction": {
		"reserveTokens": 82000,
		"keepRecentTokens": 20000
	}
}
```

Supported fields:

| Field | Accepted value |
| --- | --- |
| `contextWindow` | Positive safe integer up to `Number.MAX_SAFE_INTEGER` |
| `compaction.reserveTokens` | Non-negative safe integer up to `Number.MAX_SAFE_INTEGER` |
| `compaction.keepRecentTokens` | Non-negative safe integer up to `Number.MAX_SAFE_INTEGER` |

Validation and return behavior:

- All fields, including `compaction`, are optional. Omitted values fall back to caller or SDK defaults.
- Unknown fields at either level are rejected. This loader does not accept arbitrary Pi `settings.json` fields.
- Values are not coerced. Numeric strings, booleans, and `null` are rejected.
- Returns `{ contextWindow, settings }` with `contextWindow` removed from `settings`. Apply `contextWindow` to the resolved model when defined because it is not a Pi `SettingsManager` field.
- Missing files, unreadable files, invalid JSON, and schema violations throw instead of returning defaults. Schema errors report the file path and JSON Pointer paths such as `/compaction/reserveTokens`. Invalid JSON errors omit file contents.
- Performs no writes, logging, session creation, or model resolution.

## `pi-bot-core/agent-extensions`

This module configures the Pi SDK Codemode, tool search, and MCP extensions for a bot `AgentSession`. Codemode and the MCP client come from the Pi SDK.

### `loadBotMcpConfig(path: string): BotMcpConfig`

Reads and validates a bot-owned `mcp.json` file with the root shape `{ "mcpServers": { "<name>": { ... } } }`.

- A missing file returns `{ servers: [] }`. Malformed JSON or invalid server config throws.
- This file is the sole MCP source. Pi personal (`~/.pi/agent/mcp.json`) and project (`.pi/mcp.json`) configs are never loaded.
- Unknown fields anywhere, including root-level `autoEnableCodemode`, are rejected.
- Server names must match `/^[A-Za-z0-9_-]+$/` and remain unique when `-` is normalized to `_`.
- Each server must define either `command` (stdio) or `url` (Streamable HTTP), never both. Legacy SSE transport and provider `auth` fields are rejected. Loaded server configs preserve SDK-supported alias spellings.

Common optional fields for every server:

| Field | Type | Notes |
| --- | --- | --- |
| `description` | `string` | Human-readable server summary |
| `enabled` | `boolean` | Enables or disables the server |
| `timeout` | `number` | Positive timeout in seconds |
| `exposure` | `"codemode" \| "codemode-deferred" \| "deferred" \| "direct" \| "hidden"` | Defaults to `"codemode"` |
| `toolExposure` | `Record<string, exposure>` | Maps exact tool names or `*` patterns to an exposure mode |

Transport-specific fields:

- **stdio.** Required `command` (`string`). Optional `type: "stdio"`, `args` (`string[]`), `env` (`Record<string, string>`), and `cwd` (`string`).
- **Streamable HTTP.** Required `url` (`http:` or `https:` URL). Optional `type: "http" | "streamable-http"`, `headers` (`Record<string, string>`), and `oauth`.

Optional `oauth` object fields follow these validation rules.

| Field | Accepted value |
| --- | --- |
| `clientId`, `clientSecret`, `scope` | `string` |
| `clientName` | Non-whitespace `string` |
| `callbackPort` | Integer from `1` to `65535` |
| `callbackUrl` | `http:` loopback URL (`localhost`, `127.0.0.1`, or `[::1]`) without query or fragment. Any explicit port must match `callbackPort` when both are set. |
| `clientRegistration` | `"dcr"` or `"cimd"`. With `"cimd"`, omit `clientId` and `clientName`, and restrict any `callbackUrl` to `localhost` or `127.0.0.1` on `/callback`. |
| `authServerMetadataUrl` | `https:` URL, or `http:` URL on a loopback host |

### Value resolution at transport creation

Config values are validated during `loadBotMcpConfig` and resolved in the bot host process when a transport is created:

- `env` and `headers` values expand `$NAME` and `${NAME}` from `process.env`. Use `$$` for a literal `$` and `$!` for a literal `!`. A missing variable fails that server.
- A value starting with `!` runs the rest of the string as a shell command with a 10-second timeout and uses its trimmed stdout. On command failure or empty output, the error reports only `command failed` without leaking the command or its output.
- Leading `~` and `~/` in `command`, `args`, and `cwd` expand to the bot user's home directory. A relative `cwd` resolves against the session `cwd`.

Treat `mcp.json` as trusted operator configuration because `!` commands and stdio servers execute with the bot process privileges.

### `createBotAgentExtensions(options: BotAgentExtensionsOptions): BotAgentExtensions`

Pass these fields in `options`:

- `name` labels the inline extensions in SDK diagnostics (for example, `"example-bot"` produces `example-bot-mcp-servers` and `example-bot-system-prompt`).
- `mcp` supplies an optional `BotMcpConfig` returned by `loadBotMcpConfig`.
- `mcpLogPath` sets the file path where MCP server log notifications append.
- `systemPrompt` returns the platform-built system prompt for the turn that is starting.

The returned `BotAgentExtensions` object exposes three members:

- `extensions` contains the inline extension factories in registration order.
  1. The SDK Codemode extension (`mode: "on"`, `models: false`).
  2. When `mcp.servers` is non-empty, the SDK tool search extension, `<name>-mcp-servers`, and the SDK MCP extension.
  3. The hidden `<name>-system-prompt` extension.
- `activeToolNames` lists tool names to append to native tools in `initialActiveToolNames` (currently `["codemode"]`). Codemode stays active and batches native tools even with zero MCP servers. Scripts do not receive the `models` API. The SDK activates `tool_search` when a server uses `deferred` exposure.
- `close()` idempotently closes every MCP transport opened by this runtime, including transports still connecting or reconnecting, and resolves when all close calls settle.

### Session lifecycle and caller contract

Callers must follow these session lifecycle rules:

- Create one runtime per chat `AgentSession`. MCP transports are per chat, not a shared connection pool. Each chat with MCP servers spawns its own stdio processes and HTTP sessions.
- Disable Pi discovery on `DefaultResourceLoader` (`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`, and empty system prompt overrides).
- On every `before_agent_start`, `<name>-system-prompt` applies `systemPrompt()`. When the SDK MCP extension provides `mcp_servers` for servers with `codemode` or `deferred` tools, the extension wraps it in `<mcp_servers>...</mcp_servers>`. It inserts that block before the last `\n\n## Live State\n` heading, or appends it when that heading is absent.
- Call `session.bindExtensions()` so MCP servers begin connecting in the background on `session_start`. Startup issues (connection failures, unresolved variables, or servers needing sign-in) arrive once via `uiContext.notify(message, "warning")` containing the SDK `Run /mcp to fix.` hint. Rewrite that hint for bot operators. Extension handler errors route to `onError`.
- Shut down in exact order by emitting `session_shutdown`, awaiting `extensions.close()`, and then calling `session.dispose()`. `AgentSession.dispose()` does not emit `session_shutdown`.
- The SDK MCP extension registers a `/mcp` command. `session.prompt()` dispatches text starting with `/` to extension commands unless `expandPromptTemplates` is `false`, and `/mcp login` launches a browser sign-in on the host. Prefix user-controlled messages with trusted timestamp and sender metadata before calling `session.prompt()`.

### OAuth credentials and security boundary

HTTP servers without an `Authorization` header (any capitalization) use the SDK OAuth store at `mcp-auth.json` inside `~/.pi/agent` (or `PI_CODING_AGENT_DIR`). An explicit `Authorization` header always takes precedence over stored OAuth tokens.

- Credentials are keyed by server name and URL. Authenticate on the host using `pi mcp login <server>` with the same server name, URL, and `PI_CODING_AGENT_DIR` used by the bot.
- Stored access tokens are reused, expiring or rejected tokens refresh automatically, and rotated tokens save back through the SDK refresh lock. Keep the agent directory writable by the bot user.
- Bot connections never start an interactive browser login. Missing or revoked tokens report `<server>: needs sign-in` via `notify`. After updating credentials on the host, a waiting session reconnects on a later turn, and restarting the bot also loads the updated store.
- Sharing the OAuth store does not load personal MCP server definitions, but it shares credentials across every chat that can reach a configured server. Authorization is per bot account, not per platform user. Keep tokens out of `mcp.json` so token refreshes do not require editing config files.
- MCP servers run in the bot host process outside the workspace VM sandbox. Stdio servers execute with host privileges, and HTTP URLs resolve from the host network. Server log notifications append to `mcpLogPath`.
