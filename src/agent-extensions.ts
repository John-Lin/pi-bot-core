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
import { arr, bool, compile, int, lit, map, num, obj, oneOf, opt, str, unknown as unknownValue, type Static } from "@earendil-works/pi-schema";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export interface BotMcpServer {
	name: string;
	config: McpServerConfig | FileServerConfig;
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
					pi.registerMcpServer(server.name, sdkServerConfig(server.config));
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

const exposureSchema = oneOf(["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);
const commonServerFields = {
	description: opt(str()),
	enabled: opt(bool()),
	timeout: opt(num({ exclusiveMinimum: 0, maximum: Number.MAX_VALUE })),
	exposure: opt(exposureSchema),
	toolExposure: opt(map(exposureSchema)),
};
const oauthSchema = obj({
	clientId: opt(str()),
	clientSecret: opt(str()),
	scope: opt(str()),
	clientName: opt(str({ pattern: "\\S" })),
	callbackPort: opt(int({ minimum: 1, maximum: 65535 })),
	callbackUrl: opt(str()),
	clientRegistration: opt(oneOf(["dcr", "cimd"])),
	authServerMetadataUrl: opt(str()),
});
const stdioServerSchema = obj({
	...commonServerFields,
	type: opt(lit("stdio")),
	command: str(),
	args: opt(arr(str())),
	env: opt(map(str())),
	cwd: opt(str()),
});
const httpServerSchema = obj({
	...commonServerFields,
	type: opt(oneOf(["http", "streamable-http"])),
	url: str(),
	headers: opt(map(str())),
	oauth: opt(oauthSchema),
});

type FileServerConfig = Static<typeof stdioServerSchema | typeof httpServerSchema>;
const stdioServer = compile(stdioServerSchema);
const httpServer = compile(httpServerSchema);
const serverRecordSchema = map(unknownValue());
const serverRecord = compile(serverRecordSchema);
const rootConfig = compile(obj({ mcpServers: serverRecordSchema }, { open: true }));
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

function sdkServerConfig(config: BotMcpServer["config"]): McpServerConfig {
	const { exposure, toolExposure, ...transport } = config;
	const normalize = (value: NonNullable<typeof exposure>) => value === "codemode-deferred" ? "codemode" : value;
	const exposures = {
		...(exposure !== undefined && { exposure: normalize(exposure) }),
		...(toolExposure !== undefined && {
			toolExposure: Object.fromEntries(Object.entries(toolExposure).map(([tool, value]) => [tool, normalize(value)])),
		}),
	};
	if ("url" in transport) {
		const { type, ...http } = transport;
		return { ...http, ...exposures, ...(type !== undefined && { type: "http" }) };
	}
	return { ...transport, ...exposures };
}

function validateOAuth(value: Static<typeof oauthSchema> | undefined, invalid: (message: string) => never): void {
	if (value === undefined) return;
	const callback = value.callbackUrl === undefined ? undefined : URL.parse(value.callbackUrl);
	const port = value.callbackPort;
	if (value.callbackUrl !== undefined) {
		if (!callback || callback.protocol !== "http:" || !LOOPBACK_HOSTS.has(callback.hostname)
			|| callback.search !== "" || callback.hash !== "") {
			invalid("oauth.callbackUrl must be an http loopback URL without query or fragment");
		}
		if (callback?.port && port !== undefined && Number(callback.port) !== port) {
			invalid("oauth.callbackUrl and oauth.callbackPort name different ports");
		}
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
		const url = URL.parse(value.authServerMetadataUrl);
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))) {
			invalid("oauth.authServerMetadataUrl must use https, or http on a loopback host");
		}
	}
}

function validateServer({ path, name, raw }: { path: string; name: string; raw: unknown }): FileServerConfig {
	const invalid = (message: string): never => {
		throw new Error(`Invalid MCP config ${path}: server "${name}": ${message}`);
	};
	if (!SERVER_NAME.test(name)) return invalid("name may contain only letters, digits, _ and -");
	if (!serverRecord.check(raw)) return invalid("must be an object");
	if (Object.hasOwn(raw, "auth")) return invalid("provider auth is not supported");
	const hasCommand = Object.hasOwn(raw, "command");
	const hasUrl = Object.hasOwn(raw, "url");
	if (hasCommand === hasUrl) return invalid("must define exactly one of command or url");
	if (hasCommand && stdioServer.check(raw)) return raw;
	if (hasUrl && httpServer.check(raw)) {
		const url = URL.parse(raw.url);
		if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return invalid("url must use http or https");
		validateOAuth(raw.oauth, invalid);
		return raw;
	}
	const validator = hasCommand ? stdioServer : httpServer;
	return invalid(validator.errors(raw).map(({ path, message }) => `${path || "/"}: ${message}`).join("; "));
}

/**
 * Read and strictly validate a bot `mcp.json` (`{ "mcpServers": { ... } }`). A missing file means no
 * servers; malformed JSON or config throws. Header and env values are kept unresolved; they are
 * resolved in the bot process when a transport is created.
 */
export function loadBotMcpConfig(path: string): BotMcpConfig {
	if (!existsSync(path)) return { servers: [] };

	const source = readFileSync(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new Error(`Invalid MCP config ${path}: invalid JSON`);
	}
	if (!rootConfig.check(parsed)) {
		throw new Error(`Invalid MCP config ${path}: mcpServers must be an object`);
	}
	for (const field of Object.keys(parsed)) {
		if (field !== "mcpServers") {
			throw new Error(`Invalid MCP config ${path}: unknown field "${field}"`);
		}
	}

	const servers = Object.entries(parsed.mcpServers).map(([name, raw]) => ({
		name, config: validateServer({ path, name, raw }),
	}));
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
