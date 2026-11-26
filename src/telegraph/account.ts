import { compile, type Static } from "@earendil-works/pi-schema";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { fsErrorCode } from "../fs-errors.js";
import { createAccount } from "./client.js";
import { accessTokenSchema, storedAccountSchema } from "./types.js";

const storedAccount = compile(storedAccountSchema);
const storedAccessToken = compile(accessTokenSchema);

export function telegraphAccountPath(workspace: string): string {
	return join(workspace, ".telegraph.json");
}

/**
 * Persisted Telegraph account used to author pages on behalf of a workspace.
 * Stored at `<workspace>/.telegraph.json` and reused across all chats.
 */
export type TelegraphAccount = Static<typeof storedAccountSchema>;

function invalidAccount(file: string): Error {
	return new Error(`Invalid Telegraph account ${file}`);
}

async function readAccountFile(file: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (fsErrorCode(error) === "ENOENT") return undefined;
		throw error;
	}

	try {
		return JSON.parse(text);
	} catch {
		throw invalidAccount(file);
	}
}

/** Page tools authenticate with the token, even when a copied file omits display metadata. */
export async function loadTelegraphAccessToken(file: string): Promise<string | undefined> {
	const account = await readAccountFile(file);
	if (account === undefined) return undefined;
	if (!storedAccessToken.check(account)) throw invalidAccount(file);
	return account.access_token;
}

/**
 * Load the workspace's Telegraph account, creating one on first use.
 * The account file is the source of truth for the access token — delete it to
 * force re-provisioning (e.g. after `revokeAccessToken`).
 *
 * `short_name` and `author_name` are only consulted on first creation; the
 * persisted file wins for subsequent calls.
 */
export async function ensureTelegraphAccount(
	workspace: string,
	defaults: { short_name: string; author_name: string },
): Promise<TelegraphAccount> {
	const file = telegraphAccountPath(workspace);
	const existing = await readAccountFile(file);
	if (existing === undefined) return createStoredAccount(file, defaults);
	if (!storedAccount.check(existing)) throw invalidAccount(file);
	return existing;
}

export async function ensureTelegraphAccessToken(workspace: string, defaults: Parameters<typeof ensureTelegraphAccount>[1]): Promise<string> {
	const file = telegraphAccountPath(workspace);
	return (await loadTelegraphAccessToken(file)) ?? (await createStoredAccount(file, defaults)).access_token;
}

async function createStoredAccount(file: string, defaults: Parameters<typeof ensureTelegraphAccount>[1]): Promise<TelegraphAccount> {
	const created = await createAccount(defaults);
	const account: TelegraphAccount = {
		access_token: created.access_token,
		short_name: created.short_name,
		author_name: created.author_name,
	};
	await writeFile(file, JSON.stringify(account, null, 2));
	return account;
}
