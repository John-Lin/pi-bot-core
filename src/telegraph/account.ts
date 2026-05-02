import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createAccount } from "./client.js";

/**
 * Persisted Telegraph account used to author pages on behalf of a workspace.
 * Stored at `<workspace>/.telegraph.json` and reused across all chats.
 */
export interface TelegraphAccount {
	access_token: string;
	short_name: string;
	author_name: string;
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
	const file = join(workspace, ".telegraph.json");
	try {
		const text = await readFile(file, "utf8");
		return JSON.parse(text) as TelegraphAccount;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const created = await createAccount(defaults);
	const account: TelegraphAccount = {
		access_token: created.access_token,
		short_name: created.short_name,
		author_name: created.author_name,
	};
	await writeFile(file, JSON.stringify(account, null, 2));
	return account;
}
