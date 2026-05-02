import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAccount, createPage, editPage, getPage, getPages } from "../src/telegraph/client.js";

interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

let captured: CapturedRequest | undefined;
let nextResponse: { status?: number; statusText?: string; body: unknown } = {
	body: { ok: true, result: {} },
};
let originalFetch: typeof fetch;

beforeEach(() => {
	captured = undefined;
	nextResponse = { body: { ok: true, result: {} } };
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const headers = init?.headers as Record<string, string> | undefined;
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		captured = {
			url,
			method: init?.method ?? "GET",
			headers: headers ?? {},
			body,
		};
		const status = nextResponse.status ?? 200;
		const statusText = nextResponse.statusText ?? "OK";
		return new Response(JSON.stringify(nextResponse.body), {
			status,
			statusText,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("createAccount", () => {
	test("POSTs to /createAccount with details JSON-encoded", async () => {
		nextResponse = {
			body: {
				ok: true,
				result: { short_name: "n", author_name: "a", access_token: "tok", auth_url: "u" },
			},
		};

		const result = await createAccount({ short_name: "n", author_name: "a" });

		expect(captured?.url).toBe("https://api.telegra.ph/createAccount");
		expect(captured?.method).toBe("POST");
		expect(captured?.headers["Content-Type"]).toBe("application/json");
		expect(captured?.body).toEqual({ short_name: "n", author_name: "a" });
		expect(result.access_token).toBe("tok");
	});
});

describe("createPage", () => {
	test("POSTs access_token + page fields to /createPage", async () => {
		nextResponse = {
			body: {
				ok: true,
				result: { path: "Foo-12-31", url: "https://telegra.ph/Foo-12-31", title: "T", description: "", views: 0 },
			},
		};

		await createPage({
			access_token: "tok",
			title: "T",
			content: [{ tag: "p", children: ["hi"] }],
			author_name: "Alice",
		});

		expect(captured?.url).toBe("https://api.telegra.ph/createPage");
		expect(captured?.body).toEqual({
			access_token: "tok",
			title: "T",
			content: [{ tag: "p", children: ["hi"] }],
			author_name: "Alice",
		});
	});
});

describe("editPage", () => {
	test("POSTs to /editPage with path in the body", async () => {
		nextResponse = {
			body: { ok: true, result: { path: "p", url: "u", title: "t", description: "", views: 0 } },
		};

		await editPage({
			access_token: "tok",
			path: "Foo-12-31",
			title: "Updated",
			content: [{ tag: "p", children: ["bye"] }],
		});

		expect(captured?.url).toBe("https://api.telegra.ph/editPage");
		expect(captured?.body).toEqual({
			access_token: "tok",
			path: "Foo-12-31",
			title: "Updated",
			content: [{ tag: "p", children: ["bye"] }],
		});
	});
});

describe("getPage", () => {
	test("POSTs to /getPage with path + return_content default true", async () => {
		nextResponse = {
			body: {
				ok: true,
				result: {
					path: "p",
					url: "u",
					title: "t",
					description: "",
					views: 0,
					content: [{ tag: "p", children: ["hi"] }],
				},
			},
		};

		await getPage("Foo-12-31");

		expect(captured?.url).toBe("https://api.telegra.ph/getPage");
		expect(captured?.body).toEqual({ path: "Foo-12-31", return_content: true });
	});

	test("return_content=false is forwarded", async () => {
		nextResponse = {
			body: { ok: true, result: { path: "p", url: "u", title: "t", description: "", views: 0 } },
		};
		await getPage("p", false);
		expect(captured?.body).toEqual({ path: "p", return_content: false });
	});
});

describe("getPages", () => {
	test("POSTs to /getPageList with access_token + offset/limit", async () => {
		nextResponse = {
			body: {
				ok: true,
				result: {
					total_count: 2,
					pages: [
						{ path: "A-12-31", url: "https://telegra.ph/A-12-31", title: "A", description: "", views: 1 },
						{ path: "B-12-30", url: "https://telegra.ph/B-12-30", title: "B", description: "", views: 5 },
					],
				},
			},
		};

		const result = await getPages({ access_token: "tok", offset: 0, limit: 50 });

		expect(captured?.url).toBe("https://api.telegra.ph/getPageList");
		expect(captured?.body).toEqual({ access_token: "tok", offset: 0, limit: 50 });
		expect(result.total_count).toBe(2);
		expect(result.pages).toHaveLength(2);
		expect(result.pages[0].title).toBe("A");
	});

	test("offset/limit are optional", async () => {
		nextResponse = { body: { ok: true, result: { total_count: 0, pages: [] } } };
		await getPages({ access_token: "tok" });
		expect(captured?.body).toEqual({ access_token: "tok" });
	});
});

describe("error handling", () => {
	test("HTTP non-2xx throws with method + status", async () => {
		nextResponse = { status: 500, statusText: "Internal Server Error", body: {} };
		await expect(createAccount({ short_name: "n", author_name: "a" })).rejects.toThrow(
			/createAccount.*500/,
		);
	});

	test("API ok=false throws with the error string", async () => {
		nextResponse = { body: { ok: false, error: "SHORT_NAME_REQUIRED" } };
		await expect(createAccount({ short_name: "", author_name: "a" })).rejects.toThrow(
			/SHORT_NAME_REQUIRED/,
		);
	});

	test("API ok=true with no result throws an explicit empty-result error", async () => {
		nextResponse = { body: { ok: true } };
		await expect(createAccount({ short_name: "n", author_name: "a" })).rejects.toThrow(
			/empty result/i,
		);
	});
});
