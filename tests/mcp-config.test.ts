import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadBotMcpConfig } from "pi-bot-core/agent-extensions";

function withTempDir(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-bot-core-mcp-config-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeConfig(dir: string, value: unknown): string {
	const path = join(dir, "mcp.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

describe("loadBotMcpConfig", () => {
	test("returns no servers when the host config does not exist", () => {
		withTempDir((dir) => {
			expect(loadBotMcpConfig(join(dir, "missing.json"))).toEqual({ servers: [] });
		});
	});

	test("loads host-managed stdio and HTTP servers without resolving values", () => {
		withTempDir((dir) => {
			const path = writeConfig(dir, {
				mcpServers: {
					local: {
						command: "/opt/homebrew/bin/local-mcp",
						args: ["serve"],
						env: { TOKEN: "!print-token" },
						exposure: "codemode",
					},
					docs: {
						type: "streamable-http",
						url: "https://example.com/mcp",
						headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
						toolExposure: { "search_*": "direct" },
						enabled: false,
						timeout: 5,
						description: "Docs",
					},
				},
			});

			// Loaded configs keep the alias spellings the SDK accepts but does not type.
			expect(loadBotMcpConfig(path) as unknown).toEqual({
				servers: [
					{
						name: "local",
						config: {
							command: "/opt/homebrew/bin/local-mcp",
							args: ["serve"],
							env: { TOKEN: "!print-token" },
							exposure: "codemode",
						},
					},
					{
						name: "docs",
						config: {
							type: "streamable-http",
							url: "https://example.com/mcp",
							headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
							toolExposure: { "search_*": "direct" },
							enabled: false,
							timeout: 5,
							description: "Docs",
						},
					},
				],
			});
		});
	});

	test("rejects malformed roots and server records before returning startup config", () => {
		withTempDir((dir) => {
			for (const value of [null, [], "servers", {}, { mcpServers: null }, { mcpServers: [] }, { mcpServers: { broken: [] } }]) {
				const path = writeConfig(dir, value);
				expect(() => loadBotMcpConfig(path), JSON.stringify(value)).toThrow(/Invalid MCP config/);
			}
			const path = join(dir, "invalid-json.json");
			writeFileSync(path, "{ invalid JSON");
			expect(() => loadBotMcpConfig(path)).toThrow();
		});
	});

	test("rejects unknown top-level fields", () => {
		withTempDir((dir) => {
			const path = writeConfig(dir, {
				mcpServers: {},
				autoEnableCodemode: false,
			});

			expect(() => loadBotMcpConfig(path)).toThrow('unknown field "autoEnableCodemode"');
		});
	});

	test.each([
		{},
		{
			clientId: "registered-client",
			clientSecret: "${MCP_CLIENT_SECRET}",
			callbackPort: 8765,
			callbackUrl: "http://127.0.0.1:8765/callback",
			scope: "docs:read",
			clientName: "pi",
			clientRegistration: "dcr",
			authServerMetadataUrl: "https://auth.example.com/.well-known/openid-configuration",
		},
		{ clientRegistration: "cimd", callbackUrl: "http://localhost/callback" },
	])("loads HTTP OAuth settings: %j", (oauth) => {
		withTempDir((dir) => {
			const path = writeConfig(dir, {
				mcpServers: { docs: { url: "https://example.com/mcp", oauth } },
			});
			expect(loadBotMcpConfig(path).servers[0]?.config).toEqual({ url: "https://example.com/mcp", oauth });
		});
	});

	test.each([
		null, [], "oauth", { unknown: true }, { clientId: 123 }, { clientSecret: 123 },
		{ scope: [] }, { clientName: " " }, { callbackPort: 0 }, { callbackPort: 65536 },
		{ callbackPort: 1.5 }, { callbackPort: "8765" }, { callbackUrl: "https://example.com/callback" },
		{ callbackUrl: "http://127.0.0.1/callback?code=x" },
		{ callbackUrl: "http://127.0.0.1/callback#fragment" },
		{ callbackUrl: "http://127.0.0.1:8765/callback", callbackPort: 8766 },
		{ clientRegistration: "unknown" }, { clientRegistration: "cimd", clientId: "client" },
		{ clientRegistration: "cimd", clientName: "pi" },
		{ clientRegistration: "cimd", callbackUrl: "http://localhost/other" },
		{ clientRegistration: "cimd", callbackUrl: "http://[::1]/callback" },
		{ authServerMetadataUrl: 123 }, { authServerMetadataUrl: "http://auth.example.com/metadata" },
		{ authServerMetadataUrl: "not-a-url" },
	].map((oauth) => [oauth]))("rejects malformed OAuth settings: %j", (oauth) => {
		withTempDir((dir) => {
			const path = writeConfig(dir, {
				mcpServers: { docs: { url: "https://example.com/mcp", oauth } },
			});
			expect(() => loadBotMcpConfig(path)).toThrow("oauth");
		});
	});

	test("rejects provider-auth configurations", () => {
		withTempDir((dir) => {
			const providerAuth = writeConfig(dir, {
				mcpServers: {
					docs: { url: "https://example.com/mcp", auth: { provider: "github" } },
				},
			});
			expect(() => loadBotMcpConfig(providerAuth)).toThrow("provider auth is not supported");
		});
	});

	test("rejects malformed server entries during startup", () => {
		withTempDir((dir) => {
			const invalidServers: Array<[string, unknown]> = [
				["bad name", { command: "server" }],
				["bad-args", { command: "server", args: [1] }],
				["bad-env", { command: "server", env: { TOKEN: 1 } }],
				["bad-cwd", { command: "server", cwd: 1 }],
				["bad-command", { command: 1 }],
				["bad-url", { url: "file:///tmp/server" }],
				["bad-url-type", { url: 1 }],
				["bad-headers", { url: "https://example.com/mcp", headers: { Authorization: 1 } }],
				["bad-type", { type: "sse", url: "https://example.com/sse" }],
				["stdio-http-type", { type: "http", command: "server" }],
				["bad-exposure", { command: "server", exposure: "everything" }],
				["bad-description", { command: "server", description: 1 }],
				["bad-enabled", { command: "server", enabled: "yes" }],
				["bad-timeout", { command: "server", timeout: 0 }],
				["bad-tools", { command: "server", toolExposure: { remove: "everything" } }],
				["bad-tools-shape", { command: "server", toolExposure: [] }],
				["stdio-with-url", { command: "server", url: null }],
				["stdio-with-oauth", { command: "server", oauth: {} }],
				["stdio-with-headers", { command: "server", headers: {} }],
				["http-with-command", { url: "https://example.com/mcp", command: null }],
				["http-with-env", { url: "https://example.com/mcp", env: {} }],
				["misspelled-enabled", { command: "server", enable: false }],
			];

			for (const [name, config] of invalidServers) {
				const path = writeConfig(dir, { mcpServers: { [name]: config } });
				expect(() => loadBotMcpConfig(path), name).toThrow(`server "${name}"`);
			}

			const missingTransport = writeConfig(dir, {
				mcpServers: { broken: { args: ["serve"] } },
			});
			expect(() => loadBotMcpConfig(missingTransport)).toThrow(
				"must define exactly one of command or url",
			);

			const collidingNames = writeConfig(dir, {
				mcpServers: {
					"dev-tools": { command: "one" },
					dev_tools: { command: "two" },
				},
			});
			expect(() => loadBotMcpConfig(collidingNames)).toThrow("colliding server names");
		});
	});
});
