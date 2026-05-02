import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTelegraphListTool } from "../src/tools/telegraph.js";

let ws: string;
let originalFetch: typeof fetch;
let lastBody: Record<string, unknown> | undefined;
let nextPages: { total_count: number; pages: unknown[] } = { total_count: 0, pages: [] };

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "tg-list-"));
	lastBody = undefined;
	nextPages = { total_count: 0, pages: [] };
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		lastBody = init?.body ? JSON.parse(init.body as string) : undefined;
		return new Response(JSON.stringify({ ok: true, result: nextPages }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	rmSync(ws, { recursive: true, force: true });
});

function seedAccount() {
	writeFileSync(
		join(ws, ".telegraph.json"),
		JSON.stringify({ access_token: "tok", short_name: "x", author_name: "x" }),
	);
}

describe("createTelegraphListTool", () => {
	test("lists pages with title + url + views", async () => {
		seedAccount();
		nextPages = {
			total_count: 2,
			pages: [
				{
					path: "A-12-31",
					url: "https://telegra.ph/A-12-31",
					title: "Article A",
					description: "",
					views: 42,
				},
				{
					path: "B-12-30",
					url: "https://telegra.ph/B-12-30",
					title: "Article B",
					description: "",
					views: 5,
				},
			],
		};

		const tool = createTelegraphListTool(ws);
		const result = await tool.execute("c1", { label: "list" }, undefined);

		expect(lastBody).toEqual({ access_token: "tok" });
		const text = (result.content as { type: string; text: string }[])[0].text;
		expect(text).toContain("Article A");
		expect(text).toContain("https://telegra.ph/A-12-31");
		expect(text).toContain("Article B");
		expect(text).toContain("42 view");
		expect((result.details as { total_count: number }).total_count).toBe(2);
	});

	test("forwards offset / limit", async () => {
		seedAccount();
		const tool = createTelegraphListTool(ws);
		await tool.execute("c1", { label: "list", offset: 100, limit: 25 }, undefined);
		expect(lastBody).toEqual({ access_token: "tok", offset: 100, limit: 25 });
	});

	test("renders friendly text when no pages exist", async () => {
		seedAccount();
		nextPages = { total_count: 0, pages: [] };
		const tool = createTelegraphListTool(ws);
		const result = await tool.execute("c1", { label: "list" }, undefined);
		const text = (result.content as { type: string; text: string }[])[0].text;
		expect(text.toLowerCase()).toContain("no pages");
	});

	test("indicates pagination when total_count exceeds page slice", async () => {
		seedAccount();
		nextPages = {
			total_count: 200,
			pages: Array.from({ length: 50 }, (_, i) => ({
				path: `P-${i}`,
				url: `https://telegra.ph/P-${i}`,
				title: `Page ${i}`,
				description: "",
				views: 0,
			})),
		};
		const tool = createTelegraphListTool(ws);
		const result = await tool.execute("c1", { label: "list" }, undefined);
		const text = (result.content as { type: string; text: string }[])[0].text;
		// Should indicate there are more pages than shown.
		expect(text).toMatch(/200/);
		expect(text).toMatch(/50/);
	});

	test("throws helpful error when no .telegraph.json exists", async () => {
		const tool = createTelegraphListTool(ws);
		await expect(tool.execute("c1", { label: "list" }, undefined)).rejects.toThrow(
			/no telegraph account/i,
		);
	});
});
