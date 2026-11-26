import { compile, lit, obj, opt, str, unknown as unknownValue } from "@earendil-works/pi-schema";
import { createdAccountSchema, isRenderablePage, pageListSchema, pageSchema, type AccessToken, type Account, type AuthUrl, type Node, type Page, type PageList, type RenderablePage } from "./types.js";

const API_ROOT = "https://api.telegra.ph";
const success = compile(obj({ ok: lit(true), result: opt(unknownValue()) }, { open: true }));
const failure = compile(obj({ ok: lit(false), error: str() }, { open: true }));
const isCreatedAccount = compile(createdAccountSchema).check;
const isPage = compile(pageSchema).check;
const isPageList = compile(pageListSchema).check;

async function call<T>({ method, body, isResult }: {
	method: string;
	body: Record<string, unknown>;
	isResult: (value: unknown) => value is T;
}): Promise<T> {
	const res = await fetch(`${API_ROOT}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`Telegraph ${method} HTTP ${res.status}: ${res.statusText}`);
	}
	let json: unknown;
	try {
		json = await res.json();
	} catch {
		throw new Error(`Telegraph ${method}: invalid response JSON`);
	}
	if (failure.check(json)) throw new Error(`Telegraph ${method}: ${json.error}`);
	if (!success.check(json)) throw new Error(`Telegraph ${method}: invalid response`);
	if (json.result === undefined) throw new Error(`Telegraph ${method}: empty result`);
	if (!isResult(json.result)) throw new Error(`Telegraph ${method}: invalid result`);
	return json.result;
}

export function createAccount(details: {
	short_name: string;
	author_name?: string;
	author_url?: string;
}): Promise<Account & AccessToken & AuthUrl> {
	const result = call({ method: "createAccount", body: { ...details }, isResult: isCreatedAccount });
	// oxlint-disable-next-line typescript/consistent-type-assertions -- Preserve the published type without inventing an omitted auth_url.
	return result as Promise<Account & AccessToken & AuthUrl>;
}

export function createPage(args: {
	access_token: string;
	title: string;
	content: Node[];
	author_name?: string;
	author_url?: string;
}): Promise<Page<false>> {
	return call({ method: "createPage", body: { ...args }, isResult: isPage });
}

export function editPage(args: {
	access_token: string;
	path: string;
	title: string;
	content: Node[];
	author_name?: string;
	author_url?: string;
}): Promise<Page<false>> {
	return call({ method: "editPage", body: { ...args }, isResult: isPage });
}

export function getPage(path: string, return_content = true): Promise<Page<true>> {
	const result = return_content
		? getRenderablePage(path)
		: call({ method: "getPage", body: { path, return_content }, isResult: isPage });
	// oxlint-disable-next-line typescript/consistent-type-assertions -- Preserve the published type and leave optional or unknown page content unchanged.
	return result as Promise<Page<true>>;
}

export function getRenderablePage(path: string): Promise<RenderablePage> {
	return call({ method: "getPage", body: { path, return_content: true }, isResult: isRenderablePage });
}

export function getPages(args: {
	access_token: string;
	offset?: number;
	limit?: number;
}): Promise<PageList> {
	return call({ method: "getPageList", body: { ...args }, isResult: isPageList });
}
