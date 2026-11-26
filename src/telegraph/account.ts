import { compile, type Static } from "@earendil-works/pi-schema";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { fsErrorCode } from "../fs-errors.js";
import { createAccount } from "./client.js";
import { storedAccountSchema } from "./types.js";

const storedAccount = compile(storedAccountSchema);

export function telegraphAccountPath(workspace: string): string {
	return join(workspace, ".telegraph.json");
}

/**
 * Persisted Telegraph account used to author pages on behalf of a workspace.
 * Stored at `<workspace>/.telegraph.json` and reused across all chats.
 */
export type TelegraphAccount = Static<typeof storedAccountSchema>;

export async function loadTelegraphAccount(file: string): Promise<TelegraphAccount | undefined> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (fsErrorCode(error) === "ENOENT") return undefined;
		throw error;
	}

	const invalid = () => new Error(`Invalid Telegraph account ${file}`);
	let account: unknown;
	try {
		account = JSON.parse(text);
	} catch {
		throw invalid();
	}
	if (!storedAccount.check(account)) throw invalid();
	return account;
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
	const existing = await loadTelegraphAccount(file);
	if (existing) return existing;
	const created = await createAccount(defaults);
	const account: TelegraphAccount = {
		access_token: created.access_token,
		short_name: created.short_name,
		author_name: created.author_name,
	};
	await writeFile(file, JSON.stringify(account, null, 2));
	return account;
}
