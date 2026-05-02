import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTelegraphPublishTool } from "../src/tools/telegraph.js";

let ws: string;
let originalFetch: typeof fetch;
let calls: { url: string; body: unknown }[];

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "pi-bot-tg-"));
	calls = [];
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ url, body });
		if (url.endsWith("/createAccount")) {
			return new Response(
				JSON.stringify({
					ok: true,
					result: { access_token: "tok", short_name: "pi-bot", author_name: "pi-bot" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.endsWith("/createPage")) {
			return new Response(
				JSON.stringify({
					ok: true,
					result: {
						path: "Hello-12-31",
						url: "https://telegra.ph/Hello-12-31",
						title: "Hello",
						description: "",
						views: 0,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	rmSync(ws, { recursive: true, force: true });
});

describe("createTelegraphPublishTool", () => {
	test("execute publishes a markdown page and returns the public URL", async () => {
		const tool = createTelegraphPublishTool(ws, {
			short_name: "pi-bot",
			author_name: "pi-bot",
		});

		const result = await tool.execute(
			"call-1",
			{ label: "demo", title: "Hello", content: "Hello **world**" },
			undefined,
		);

		expect(calls.map((c) => c.url)).toEqual([
			"https://api.telegra.ph/createAccount",
			"https://api.telegra.ph/createPage",
		]);

		const createPage = calls[1].body as Record<string, unknown>;
		expect(createPage.access_token).toBe("tok");
		expect(createPage.title).toBe("Hello");
		expect(createPage.content).toEqual([
			{ tag: "p", children: ["Hello ", { tag: "strong", children: ["world"] }] },
		]);

		expect(result.details).toMatchObject({
			url: "https://telegra.ph/Hello-12-31",
			path: "Hello-12-31",
			title: "Hello",
		});
		expect(existsSync(join(ws, ".telegraph.json"))).toBe(true);
	});

	test("forwards optional author_name override to createPage", async () => {
		const tool = createTelegraphPublishTool(ws, {
			short_name: "pi-bot",
			author_name: "pi-bot",
		});
		await tool.execute(
			"call-1",
			{ label: "demo", title: "T", content: "x", author_name: "Custom" },
			undefined,
		);

		const createPage = calls.find((c) => c.url.endsWith("/createPage"))?.body as Record<string, unknown>;
		expect(createPage.author_name).toBe("Custom");
	});

	test("does not re-create account when .telegraph.json exists", async () => {
		// First call creates the account file.
		const tool = createTelegraphPublishTool(ws, { short_name: "pi-bot", author_name: "pi-bot" });
		await tool.execute("c1", { label: "x", title: "T", content: "x" }, undefined);
		const accountFile = readFileSync(join(ws, ".telegraph.json"), "utf8");

		calls = [];
		await tool.execute("c2", { label: "x", title: "T", content: "x" }, undefined);

		expect(calls.map((c) => c.url)).toEqual(["https://api.telegra.ph/createPage"]);
		// account file unchanged
		expect(readFileSync(join(ws, ".telegraph.json"), "utf8")).toBe(accountFile);
	});
});
