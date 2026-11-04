/**
 * Codemode and MCP for bot `AgentSession`s.
 *
 * `loadBotMcpConfig` strictly validates a bot-owned `mcp.json`. `createBotAgentExtensions` builds
 * the SDK extension factories every bot session uses: Codemode (always on, without the `models`
 * API), and, when MCP servers are configured, tool search plus the SDK MCP extension fed only by
 * that config. MCP runs in the bot process, outside any workspace sandbox, and each runtime owns
 * the transports of one session; it is not a shared connection pool. See README for the caller
 * contract.
 */
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	type InlineExtension,
	type McpServerConfig,
	type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import {
	type McpTransport,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export interface BotMcpServer {
	name: string;
	config: McpServerConfig;
}

export interface BotMcpConfig {
	servers: BotMcpServer[];
}

export interface BotAgentExtensionsOptions {
	/**
	 * Bot name used to label the inline extensions in SDK diagnostics: `telegram` gives
	 * `telegram-mcp-servers` and `telegram-system-prompt`.
	 */
	name: string;
	/** Servers from `loadBotMcpConfig`. Without servers, Codemode still serves the native tools. */
	mcp?: BotMcpConfig;
	/** File that MCP server log notifications are appended to. */
	mcpLogPath: string;
	/** Returns the platform-built system prompt for the turn that is starting. */
	systemPrompt: () => string;
}

export interface BotAgentExtensions {
	/** Pass as `DefaultResourceLoader`'s `extensionFactories`. */
	extensions: InlineExtension[];
	/** Append to the session's `initialActiveToolNames` after the native tool names. */
	activeToolNames: readonly string[];
	/** Close every MCP transport this runtime opened. Call after emitting `session_shutdown`. Idempotent. */
	close(): Promise<void>;
}

function resolveConfigValue(value: string, description: string): string {
	if (value.startsWith("!")) {
		try {
			const resolved = execSync(value.slice(1), {
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (resolved === "") throw new Error("empty command output");
			return resolved;
		} catch {
			// The command and its output may contain secrets, so neither is reported.
			throw new Error(`${description}: command failed`);
		}
	}
	const escapedDollar = "\u0000DOLLAR\u0000";
	const escapedBang = "\u0000BANG\u0000";
	return value
		.replace(/\$\$/g, escapedDollar)
		.replace(/\$!/g, escapedBang)
		.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced, plain) => {
			const name = String(braced ?? plain);
			const resolved = process.env[name];
			if (resolved === undefined) throw new Error(`${description}: missing environment variable ${name}`);
			return resolved;
		})
		.replaceAll(escapedDollar, "$")
		.replaceAll(escapedBang, "!");
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/** Builds transports from trusted operator config and tracks them so `close()` can stop them. */
class BotMcpTransportManager {
	private readonly transports = new Set<McpTransport>();

	readonly createTransport: McpTransportFactory = (entry, cwd, authProvider) => {
		const config = entry.config;
		let transport: McpTransport;
		if ("url" in config) {
			const headers = Object.fromEntries(
				Object.entries(config.headers ?? {}).map(([name, value]) => [
					name,
					resolveConfigValue(value, `MCP server "${entry.name}" header "${name}"`),
				]),
			);
			// The SDK supplies an OAuth provider only when no Authorization header is configured.
			transport = new StreamableHttpTransport({ url: config.url, headers, authProvider });
		} else {
			const env = Object.fromEntries(
				Object.entries(config.env ?? {}).map(([name, value]) => [
					name,
					resolveConfigValue(value, `MCP server "${entry.name}" env "${name}"`),
				]),
			);
			transport = new StdioTransport({
				command: expandHome(config.command),
				args: config.args?.map(expandHome),
				cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
				env,
				stderr: "pipe",
			});
		}
		this.transports.add(transport);
		transport.onClose(() => this.transports.delete(transport));
		return transport;
	};

	async close(): Promise<void> {
		const transports = [...this.transports];
		this.transports.clear();
		await Promise.allSettled(transports.map((transport) => transport.close()));
	}
}

function addMcpServersToSystemPrompt(systemPrompt: string, mcpServers: string): string {
	const section = `<mcp_servers>\n${mcpServers}\n</mcp_servers>`;
	const liveStateHeading = "\n\n## Live State\n";
	const liveStateIndex = systemPrompt.lastIndexOf(liveStateHeading);
	if (liveStateIndex < 0) return `${systemPrompt}\n\n${section}`;
	return `${systemPrompt.slice(0, liveStateIndex)}\n\n${section}${systemPrompt.slice(liveStateIndex)}`;
}

/**
 * Create one session's Codemode and MCP extensions. OAuth credentials come from the SDK store
 * (`mcp-auth.json` in the Pi agent directory), selected by server name and URL; Pi's personal and
 * project `mcp.json` files are never loaded.
 */
export function createBotAgentExtensions(options: BotAgentExtensionsOptions): BotAgentExtensions {
	const servers = options.mcp?.servers ?? [];
	const transports = new BotMcpTransportManager();
	const mcpExtensions: InlineExtension[] = servers.length === 0 ? [] : [
		createToolSearchExtension(),
		{
			name: `${options.name}-mcp-servers`,
			factory: (pi) => {
				for (const server of servers) {
					pi.registerMcpServer(server.name, server.config);
				}
			},
		},
		createMcpExtension({
			loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: true }),
			createTransport: transports.createTransport,
			logPath: options.mcpLogPath,
		}),
	];
	return {
		extensions: [
			createCodemodeExtension({ mode: "on", models: false }),
			...mcpExtensions,
			{
				name: `${options.name}-system-prompt`,
				hidden: true,
				factory: (pi) => {
					pi.on("before_agent_start", (event) => {
						// A forced system prompt drops Pi's structured sections. Preserve the MCP
						// server directory while keeping per-turn Live State at the end.
						const systemPrompt = options.systemPrompt();
						const mcpServers = event.systemPromptOptions.sections.mcp_servers;
						return {
							systemPrompt: mcpServers
								? addMcpServersToSystemPrompt(systemPrompt, mcpServers)
								: systemPrompt,
						};
					});
				},
			},
		],
		activeToolNames: ["codemode"],
		close: () => transports.close(),
	};
}

const EXPOSURES = new Set(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);
const COMMON_SERVER_FIELDS = ["type", "description", "enabled", "timeout", "exposure", "toolExposure"];
const STDIO_SERVER_FIELDS = new Set([...COMMON_SERVER_FIELDS, "command", "args", "env", "cwd"]);
const HTTP_SERVER_FIELDS = new Set([...COMMON_SERVER_FIELDS, "url", "headers", "oauth"]);
const OAUTH_STRING_FIELDS = ["clientId", "clientSecret", "scope", "clientName"];
const OAUTH_FIELDS = new Set([
	...OAUTH_STRING_FIELDS, "callbackPort", "callbackUrl", "clientRegistration", "authServerMetadataUrl",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validateOAuth(value: unknown, invalid: (message: string) => never): void {
	if (value === undefined) return;
	if (!isRecord(value)) return invalid("oauth must be an object");
	for (const field of Object.keys(value)) {
		if (!OAUTH_FIELDS.has(field)) invalid(`unknown oauth field "${field}"`);
	}
	for (const field of OAUTH_STRING_FIELDS) {
		if (value[field] !== undefined && typeof value[field] !== "string") invalid(`oauth.${field} must be a string`);
	}
	if (typeof value.clientName === "string" && value.clientName.trim() === "") {
		invalid("oauth.clientName must be non-empty");
	}
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		invalid("oauth.callbackPort must be a port number");
	}
	const callback = typeof value.callbackUrl === "string" && URL.canParse(value.callbackUrl)
		? new URL(value.callbackUrl) : undefined;
	if (value.callbackUrl !== undefined) {
		if (!callback || callback.protocol !== "http:" || !LOOPBACK_HOSTS.has(callback.hostname)
			|| callback.search !== "" || callback.hash !== "") {
			invalid("oauth.callbackUrl must be an http loopback URL without query or fragment");
		}
		if (callback?.port && port !== undefined && Number(callback.port) !== port) {
			invalid("oauth.callbackUrl and oauth.callbackPort name different ports");
		}
	}
	if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr" && value.clientRegistration !== "cimd") {
		invalid('oauth.clientRegistration must be "dcr" or "cimd"');
	}
	if (value.clientRegistration === "cimd") {
		if (value.clientId !== undefined || value.clientName !== undefined) {
			invalid("oauth.clientRegistration cimd cannot be combined with clientId or clientName");
		}
		if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
			invalid("oauth.clientRegistration cimd requires a localhost or 127.0.0.1 /callback URL");
		}
	}
	if (value.authServerMetadataUrl !== undefined) {
		const url = typeof value.authServerMetadataUrl === "string" && URL.canParse(value.authServerMetadataUrl)
			? new URL(value.authServerMetadataUrl) : undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))) {
			invalid("oauth.authServerMetadataUrl must use https, or http on a loopback host");
		}
	}
}

function validateServer(path: string, name: string, raw: Record<string, unknown>): McpServerConfig {
	const invalid = (message: string): never => {
		throw new Error(`Invalid MCP config ${path}: server "${name}": ${message}`);
	};
	if (!SERVER_NAME.test(name)) invalid("name may contain only letters, digits, _ and -");
	if (raw.auth !== undefined) invalid("provider auth is not supported");
	if (raw.exposure !== undefined && (typeof raw.exposure !== "string" || !EXPOSURES.has(raw.exposure))) {
		invalid("invalid exposure");
	}
	if (raw.toolExposure !== undefined) {
		if (!isRecord(raw.toolExposure)) invalid("toolExposure must be an object");
		for (const exposure of Object.values(raw.toolExposure as Record<string, unknown>)) {
			if (typeof exposure !== "string" || !EXPOSURES.has(exposure)) invalid("invalid tool exposure");
		}
	}
	if (raw.description !== undefined && typeof raw.description !== "string") invalid("description must be a string");
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") invalid("enabled must be a boolean");
	if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || raw.timeout <= 0)) {
		invalid("timeout must be a positive number");
	}

	const hasCommand = Object.hasOwn(raw, "command");
	const hasUrl = Object.hasOwn(raw, "url");
	if (hasCommand === hasUrl) invalid("must define exactly one of command or url");
	const allowedFields = hasCommand ? STDIO_SERVER_FIELDS : HTTP_SERVER_FIELDS;
	for (const field of Object.keys(raw)) {
		if (!allowedFields.has(field)) invalid(`unknown field "${field}"`);
	}
	if (hasCommand) {
		if (typeof raw.command !== "string") invalid("command must be a string");
		if (raw.type !== undefined && raw.type !== "stdio") invalid("stdio server type must be stdio");
		if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))) {
			invalid("args must be an array of strings");
		}
		if (raw.env !== undefined && !isStringRecord(raw.env)) invalid("env must map names to strings");
		if (raw.cwd !== undefined && typeof raw.cwd !== "string") invalid("cwd must be a string");
	} else {
		if (typeof raw.url !== "string") invalid("url must be a string");
		if (raw.type !== undefined && raw.type !== "http" && raw.type !== "streamable-http") {
			invalid("HTTP server type must be http or streamable-http");
		}
		if (!URL.canParse(raw.url as string) || !/^https?:$/.test(new URL(raw.url as string).protocol)) {
			invalid("url must use http or https");
		}
		if (raw.headers !== undefined && !isStringRecord(raw.headers)) invalid("headers must map names to strings");
		validateOAuth(raw.oauth, invalid);
	}
	return raw as unknown as McpServerConfig;
}

/**
 * Read and strictly validate a bot `mcp.json` (`{ "mcpServers": { ... } }`). A missing file means no
 * servers; malformed JSON or config throws. Header and env values are kept unresolved; they are
 * resolved in the bot process when a transport is created.
 */
export function loadBotMcpConfig(path: string): BotMcpConfig {
	if (!existsSync(path)) return { servers: [] };

	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		throw new Error(`Invalid MCP config ${path}: mcpServers must be an object`);
	}
	for (const field of Object.keys(parsed)) {
		if (field !== "mcpServers") {
			throw new Error(`Invalid MCP config ${path}: unknown field "${field}"`);
		}
	}

	const servers = Object.entries(parsed.mcpServers).map(([name, raw]) => {
		if (!isRecord(raw)) {
			throw new Error(`Invalid MCP config ${path}: server "${name}" must be an object`);
		}
		return { name, config: validateServer(path, name, raw) };
	});
	const namespaces = new Set<string>();
	for (const server of servers) {
		const namespace = server.name.replace(/-/g, "_");
		if (namespaces.has(namespace)) {
			throw new Error(`Invalid MCP config ${path}: colliding server names map to "${namespace}"`);
		}
		namespaces.add(namespace);
	}

	return { servers };
}
