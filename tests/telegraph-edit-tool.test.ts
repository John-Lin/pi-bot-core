import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTelegraphEditTool } from "../src/tools/telegraph.js";

let ws: string;
let originalFetch: typeof fetch;
let lastUrl: string | undefined;
let lastBody: Record<string, unknown> | undefined;

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "tg-edit-"));
	lastUrl = undefined;
	lastBody = undefined;
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		lastUrl = typeof input === "string" ? input : input.toString();
		lastBody = init?.body ? JSON.parse(init.body as string) : undefined;
		return new Response(
			JSON.stringify({
				ok: true,
				result: {
					path: "Hello-12-31",
					url: "https://telegra.ph/Hello-12-31",
					title: "Hello updated",
					description: "",
					views: 0,
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	rmSync(ws, { recursive: true, force: true });
});

function seedAccount() {
	writeFileSync(
		join(ws, ".telegraph.json"),
		JSON.stringify({ access_token: "tok_existing", short_name: "x", author_name: "x" }),
	);
}

describe("createTelegraphEditTool", () => {
	test("calls editPage with parsed Markdown content", async () => {
		seedAccount();
		const tool = createTelegraphEditTool(ws);
		const result = await tool.execute(
			"call-1",
			{
				label: "edit",
				url_or_path: "Hello-12-31",
				title: "Hello updated",
				content: "Hello **world** updated.",
			},
			undefined,
		);

		expect(lastUrl).toBe("https://api.telegra.ph/editPage");
		expect(lastBody).toEqual({
			access_token: "tok_existing",
			path: "Hello-12-31",
			title: "Hello updated",
			content: [
				{ tag: "p", children: ["Hello ", { tag: "strong", children: ["world"] }, " updated."] },
			],
		});
		expect(result.details).toMatchObject({
			url: "https://telegra.ph/Hello-12-31",
			path: "Hello-12-31",
		});
	});

	test("extracts path from full URL", async () => {
		seedAccount();
		const tool = createTelegraphEditTool(ws);
		await tool.execute(
			"call-1",
			{
				label: "edit",
				url_or_path: "https://telegra.ph/Hello-12-31",
				title: "T",
				content: "x",
			},
			undefined,
		);
		expect(lastBody?.path).toBe("Hello-12-31");
	});

	test("forwards optional author_name override", async () => {
		seedAccount();
		const tool = createTelegraphEditTool(ws);
		await tool.execute(
			"call-1",
			{
				label: "edit",
				url_or_path: "Hello-12-31",
				title: "T",
				content: "x",
				author_name: "Alice",
			},
			undefined,
		);
		expect(lastBody?.author_name).toBe("Alice");
	});

	test("throws a helpful error when no .telegraph.json exists in the workspace", async () => {
		const tool = createTelegraphEditTool(ws);
		await expect(
			tool.execute(
				"call-1",
				{ label: "edit", url_or_path: "Hello-12-31", title: "T", content: "x" },
				undefined,
			),
		).rejects.toThrow(/no telegraph account/i);
	});
});
