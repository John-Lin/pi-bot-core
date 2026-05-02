import type { AccessToken, Account, AuthUrl, Node, Page } from "./types.js";

const API_ROOT = "https://api.telegra.ph";

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
	const res = await fetch(`${API_ROOT}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`Telegraph ${method} HTTP ${res.status}: ${res.statusText}`);
	}
	const json = (await res.json()) as { ok: boolean; result?: T; error?: string };
	if (!json.ok) {
		throw new Error(`Telegraph ${method}: ${json.error}`);
	}
	return json.result as T;
}

export function createAccount(details: {
	short_name: string;
	author_name?: string;
	author_url?: string;
}): Promise<Account & AccessToken & AuthUrl> {
	return call("createAccount", { ...details });
}

export function createPage(args: {
	access_token: string;
	title: string;
	content: Node[];
	author_name?: string;
	author_url?: string;
	return_content?: boolean;
}): Promise<Page<boolean>> {
	return call("createPage", { ...args });
}

export function editPage(args: {
	access_token: string;
	path: string;
	title: string;
	content: Node[];
	author_name?: string;
	author_url?: string;
	return_content?: boolean;
}): Promise<Page<boolean>> {
	return call("editPage", { ...args });
}

export function getPage(path: string, return_content = true): Promise<Page<true>> {
	return call("getPage", { path, return_content });
}
