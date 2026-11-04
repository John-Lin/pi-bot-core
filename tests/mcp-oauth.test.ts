import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { startMcpHttpServer } from "./fixtures/mcp-http-server.js";
import { startMcpOAuthServer } from "./fixtures/mcp-oauth-server.js";
import {
	type BotSession,
	createBotSession,
	type IsolatedEnvironment,
	isolateEnvironment,
	outputText,
	runCodemode,
	waitFor,
} from "./helpers/bot-session.js";

const ECHO = 'return await tools.mcp__fixture__echo_http({ text: "oauth" });';
const INTERACTIVE_PATHS = ["/authorize", "/register"];

describe("host-managed MCP OAuth credentials", () => {
	let env: IsolatedEnvironment;
	let sessions: BotSession[];
	let servers: Array<{ stop(): void }>;

	beforeEach(() => {
		env = isolateEnvironment("pi-bot-core-oauth-");
		sessions = [];
		servers = [];
	});

	afterEach(async () => {
		try {
			await Promise.all(sessions.map((bot) => bot.shutdown()));
			for (const server of servers) server.stop();
		} finally {
			env.restore();
		}
	});

	function saveCredentials(url: string, token: string, options: {
		name?: string;
		expired?: boolean;
		refreshToken?: string;
	} = {}) {
		const key = `mcp__${options.name ?? "fixture"}|${url}`;
		writeFileSync(join(env.agentDir, "mcp-auth.json"), JSON.stringify({
			[key]: {
				serverUrl: url,
				clientInformation: { client_id: "test-client", redirect_uris: ["http://127.0.0.1/callback"] },
				tokens: { access_token: token, token_type: "Bearer", refresh_token: options.refreshToken },
				tokensExpireAt: Date.now() + (options.expired ? -60_000 : 3_600_000),
			},
		}));
	}

	async function connect(config: McpServerConfig): Promise<BotSession> {
		const bot = await createBotSession(env, { mcp: { servers: [{ name: "fixture", config }] } });
		sessions.push(bot);
		return bot;
	}

	function oauthServer() {
		const server = startMcpOAuthServer();
		servers.push(server);
		return server;
	}

	test("reuses stored credentials across restarts", async () => {
		const server = oauthServer();
		saveCredentials(server.url, "valid-token");

		for (let attempt = 0; attempt < 2; attempt++) {
			const bot = await connect({ url: server.url });
			const outcome = await runCodemode(bot.session, ECHO);
			expect(outcome.isError, outputText(outcome)).toBe(false);
			expect(outputText(outcome)).toContain("HTTP_MCP:oauth");
			expect(bot.notifications).toEqual([]);
			await bot.shutdown();
		}

		expect(server.authorizations.length).toBeGreaterThan(0);
		expect(server.authorizations.every((value) => value === "Bearer valid-token")).toBe(true);
		expect(server.refreshRequests).toHaveLength(0);
	});

	test.each(["expired", "rejected"])("refreshes %s tokens and persists rotated credentials", async (reason) => {
		const server = oauthServer();
		saveCredentials(server.url, `${reason}-token`, { expired: reason === "expired", refreshToken: "refresh-token" });
		const bot = await connect({ url: server.url });

		const outcome = await runCodemode(bot.session, ECHO);

		expect(outcome.isError, outputText(outcome)).toBe(false);
		expect(outputText(outcome)).toContain("HTTP_MCP:oauth");
		expect(server.refreshRequests).toHaveLength(1);
		expect(server.refreshRequests[0]?.get("client_id")).toBe("test-client");
		const states = JSON.parse(readFileSync(join(env.agentDir, "mcp-auth.json"), "utf8"));
		const state = states[`mcp__fixture|${server.url}`];
		expect(state.tokens.access_token).toBe("refreshed-token");
		expect(state.tokens.refresh_token).toBe("rotated-refresh-token");
		expect(state.tokensExpireAt).toBeGreaterThan(Date.now());
		expect(server.authorizations).toContain("Bearer refreshed-token");
		if (reason === "rejected") expect(server.authorizations).toContain("Bearer rejected-token");
		expect(bot.notifications).toEqual([]);
	});

	test("explicit Authorization headers take precedence over stored OAuth tokens", async () => {
		const server = oauthServer();
		saveCredentials(server.url, "must-not-send-this-token", { expired: true, refreshToken: "refresh-token" });
		const bot = await connect({ url: server.url, headers: { authorization: "Bearer valid-token" } });

		const outcome = await runCodemode(bot.session, ECHO);

		expect(outcome.isError, outputText(outcome)).toBe(false);
		expect(server.authorizations.every((value) => value === "Bearer valid-token")).toBe(true);
		expect(server.refreshRequests).toHaveLength(0);
		expect(bot.notifications).toEqual([]);
	});

	test.each(["name", "url"])("does not send credentials stored for a different %s", async (mismatch) => {
		const server = startMcpHttpServer();
		servers.push(server);
		saveCredentials(mismatch === "url" ? `${server.url}/other` : server.url, "private-token", {
			name: mismatch === "name" ? "other" : "fixture",
		});
		const bot = await connect({ url: server.url });

		const outcome = await runCodemode(bot.session, ECHO);

		expect(outcome.isError, outputText(outcome)).toBe(false);
		expect(server.authorization).toBeNull();
		expect(bot.notifications).toEqual([]);
	});

	test("reports missing sign-in without starting an interactive flow", async () => {
		const server = oauthServer();
		const bot = await connect({ url: server.url });

		const outcome = await runCodemode(bot.session, ECHO);
		await waitFor(() => bot.notifications.length > 0, "sign-in warning");

		expect(outcome.isError).toBe(true);
		expect(bot.notifications).toHaveLength(1);
		expect(bot.notifications[0]!.type).toBe("warning");
		expect(bot.notifications[0]!.message).toContain("fixture: needs sign-in");
		expect(server.refreshRequests).toHaveLength(0);
		expect(server.paths.filter((path) => INTERACTIVE_PATHS.includes(path))).toEqual([]);
	});
});
