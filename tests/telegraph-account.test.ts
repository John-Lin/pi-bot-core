import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureTelegraphAccount } from "../src/telegraph/account.js";

let ws: string;
let originalFetch: typeof fetch;
let fetchCalls: number;
let lastBody: unknown;
let nextAccount: { access_token: string; short_name: string; author_name: string };

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "pi-bot-tg-"));
	fetchCalls = 0;
	lastBody = undefined;
	nextAccount = { access_token: "tok_default", short_name: "?", author_name: "?" };
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		fetchCalls += 1;
		lastBody = init?.body ? JSON.parse(init.body as string) : undefined;
		return new Response(JSON.stringify({ ok: true, result: nextAccount }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	rmSync(ws, { recursive: true, force: true });
});

describe("ensureTelegraphAccount", () => {
	test("creates account on first use and persists to .telegraph.json", async () => {
		nextAccount = { access_token: "tok_abc", short_name: "pi-bot", author_name: "pi-bot" };

		const account = await ensureTelegraphAccount(ws, {
			short_name: "pi-bot",
			author_name: "pi-bot",
		});

		expect(fetchCalls).toBe(1);
		expect(lastBody).toEqual({ short_name: "pi-bot", author_name: "pi-bot" });
		expect(account.access_token).toBe("tok_abc");

		const onDisk = JSON.parse(readFileSync(join(ws, ".telegraph.json"), "utf8"));
		expect(onDisk.access_token).toBe("tok_abc");
		expect(onDisk.short_name).toBe("pi-bot");
	});

	test("reuses existing .telegraph.json without calling fetch", async () => {
		writeFileSync(
			join(ws, ".telegraph.json"),
			JSON.stringify({
				access_token: "existing",
				short_name: "x",
				author_name: "y",
			}),
		);

		const account = await ensureTelegraphAccount(ws, {
			short_name: "should-not-be-used",
			author_name: "should-not-be-used",
		});

		expect(fetchCalls).toBe(0);
		expect(account.access_token).toBe("existing");
		expect(account.short_name).toBe("x");
	});

	test("forwards caller-supplied short_name/author_name to createAccount", async () => {
		nextAccount = { access_token: "t", short_name: "Alice-bot", author_name: "Alice" };

		await ensureTelegraphAccount(ws, {
			short_name: "Alice-bot",
			author_name: "Alice",
		});

		expect(lastBody).toEqual({ short_name: "Alice-bot", author_name: "Alice" });
		expect(existsSync(join(ws, ".telegraph.json"))).toBe(true);
	});
});
