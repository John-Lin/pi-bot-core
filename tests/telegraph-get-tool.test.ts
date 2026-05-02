import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTelegraphGetTool } from "../src/tools/telegraph.js";

let originalFetch: typeof fetch;
let lastBody: Record<string, unknown> | undefined;
let nextContent: unknown = [
	{ tag: "h3", children: ["Hello"] },
	{
		tag: "p",
		children: ["body ", { tag: "strong", children: ["bold"] }],
	},
];

beforeEach(() => {
	lastBody = undefined;
	nextContent = [
		{ tag: "h3", children: ["Hello"] },
		{
			tag: "p",
			children: ["body ", { tag: "strong", children: ["bold"] }],
		},
	];
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		lastBody = init?.body ? JSON.parse(init.body as string) : undefined;
		return new Response(
			JSON.stringify({
				ok: true,
				result: {
					path: "Hello-12-31",
					url: "https://telegra.ph/Hello-12-31",
					title: "Hello",
					description: "",
					views: 42,
					can_edit: true,
					content: nextContent,
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("createTelegraphGetTool", () => {
	test("calls getPage with the given path and returns content as Markdown", async () => {
		const tool = createTelegraphGetTool();
		const result = await tool.execute(
			"call-1",
			{ label: "read", url_or_path: "Hello-12-31" },
			undefined,
		);

		expect(lastBody).toEqual({ path: "Hello-12-31", return_content: true });
		const text = (result.content as { type: string; text: string }[])[0].text;
		expect(text).toContain("Hello");
		expect(text).toContain("body **bold**");
		expect(result.details).toMatchObject({
			url: "https://telegra.ph/Hello-12-31",
			path: "Hello-12-31",
			title: "Hello",
			can_edit: true,
		});
		expect((result.details as { content: string }).content).toContain("body **bold**");
	});

	test("extracts path from a full telegra.ph URL", async () => {
		const tool = createTelegraphGetTool();
		await tool.execute(
			"call-1",
			{ label: "read", url_or_path: "https://telegra.ph/Hello-12-31" },
			undefined,
		);
		expect(lastBody?.path).toBe("Hello-12-31");
	});

	test("strips trailing query/fragments from URL", async () => {
		const tool = createTelegraphGetTool();
		await tool.execute(
			"call-1",
			{ label: "read", url_or_path: "https://telegra.ph/Hello-12-31?foo=bar#sec" },
			undefined,
		);
		expect(lastBody?.path).toBe("Hello-12-31");
	});

	test("accepts protocol-less host/path", async () => {
		const tool = createTelegraphGetTool();
		await tool.execute(
			"call-1",
			{ label: "read", url_or_path: "telegra.ph/Hello-12-31" },
			undefined,
		);
		expect(lastBody?.path).toBe("Hello-12-31");
	});

	test("when content arrives as a string, parses it as Markdown before serialising", async () => {
		// The Telegraph type is `string | Node[]`; this test pins the string branch.
		nextContent = "# From string\n\nplain content";
		const tool = createTelegraphGetTool();
		const result = await tool.execute(
			"call-1",
			{ label: "read", url_or_path: "Hello-12-31" },
			undefined,
		);
		const md = (result.details as { content: string }).content;
		expect(md).toContain("From string");
		expect(md).toContain("plain content");
	});
});
