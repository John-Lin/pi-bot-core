import type { AgentTool } from "@mariozechner/pi-agent-core";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Type } from "typebox";
import { ensureTelegraphAccount, type TelegraphAccount } from "../telegraph/account.js";
import { createPage, editPage, getPage, getPages } from "../telegraph/client.js";
import { parse } from "../telegraph/parser.js";
import { serialize } from "../telegraph/serializer.js";
import type { Node } from "../telegraph/types.js";

function loadAccount(workspace: string): TelegraphAccount {
	const file = join(workspace, ".telegraph.json");
	if (!existsSync(file)) {
		throw new Error(
			`No telegraph account found at ${file}. Publish a page first via telegraph_publish, ` +
				`or copy an existing .telegraph.json into the workspace.`,
		);
	}
	return JSON.parse(readFileSync(file, "utf8")) as TelegraphAccount;
}

/**
 * Telegraph page paths look like `Title-MM-DD` or `Title-MM-DD-N`. Accept
 * either a bare path or a full telegra.ph URL and return just the path
 * segment so callers don't need to remember which form they hold.
 */
function extractPath(input: string): string {
	const trimmed = input.trim();
	if (URL.canParse(trimmed)) {
		const url = new URL(trimmed);
		const seg = url.pathname.replace(/^\/+/, "").split("/")[0];
		if (seg) return seg;
	}
	if (trimmed.includes("/")) {
		const parts = trimmed.split("/").filter(Boolean);
		const last = parts[parts.length - 1];
		if (last) return last;
	}
	return trimmed;
}

const publishSchema = Type.Object({
	label: Type.String({
		description: "Short description of what you're publishing (shown to the user)",
	}),
	title: Type.String({ description: "Page title" }),
	content: Type.String({ description: "Page body in Markdown" }),
	author_name: Type.Optional(
		Type.String({
			description: "Override the author name shown under the title for this page",
		}),
	),
});

/**
 * Publish a Markdown article to Telegraph (telegra.ph).
 *
 * A workspace-wide Telegraph account is auto-provisioned on first use and
 * persisted at `<workspace>/.telegraph.json`. The `defaults` only affect
 * account creation; subsequent calls reuse whatever short_name / author_name
 * the existing account already has.
 */
export function createTelegraphPublishTool(
	workspace: string,
	defaults: { short_name: string; author_name: string },
): AgentTool<typeof publishSchema> {
	return {
		name: "telegraph_publish",
		label: "telegraph_publish",
		description:
			"Publish a new Markdown article to Telegraph (telegra.ph) and return the public URL. " +
			"A workspace-wide Telegraph account is created automatically on first use and persisted " +
			"at <workspace>/.telegraph.json. Supported Markdown: headings (h3/h4 only; h1/h2 downgrade), " +
			"bold, italic, links, images, inline code, code blocks, blockquote, and lists. " +
			"Tables are not supported by Telegraph and will be dropped.",
		parameters: publishSchema,
		execute: async (_toolCallId, { title, content, author_name }, signal) => {
			signal?.throwIfAborted();

			const account = await ensureTelegraphAccount(workspace, defaults);
			const nodes = parse(content);
			const page = await createPage({
				access_token: account.access_token,
				title,
				content: nodes,
				...(author_name ? { author_name } : {}),
			});

			return {
				content: [
					{
						type: "text",
						text: `Published to Telegraph: ${page.url}\n(path: ${page.path})`,
					},
				],
				details: { url: page.url, path: page.path, title: page.title },
			};
		},
	};
}

const getSchema = Type.Object({
	label: Type.String({
		description: "Short description of what you're reading (shown to the user)",
	}),
	url_or_path: Type.String({
		description:
			"Either a full telegra.ph URL (e.g. https://telegra.ph/Hello-12-31) or just the path segment (Hello-12-31).",
	}),
});

/**
 * Read a Telegraph page. Returns the title plus the body rendered back to
 * Markdown so the agent can quote, summarise, translate, or feed it into a
 * subsequent `telegraph_edit` call.
 */
export function createTelegraphGetTool(): AgentTool<typeof getSchema> {
	return {
		name: "telegraph_get",
		label: "telegraph_get",
		description:
			"Fetch an existing Telegraph (telegra.ph) page and return its title plus body as Markdown. " +
			"Use this when the user shares a telegra.ph URL, when you need to summarise/translate an existing page, " +
			"or as a precursor to telegraph_edit when modifying (rather than wholesale rewriting) an existing page.",
		parameters: getSchema,
		execute: async (_toolCallId, { url_or_path }, signal) => {
			signal?.throwIfAborted();

			const path = extractPath(url_or_path);
			const page = await getPage(path);
			const md = serialize((page.content ?? []) as Node[]);

			const header = `# ${page.title}\n(path: ${page.path}, url: ${page.url}${page.can_edit ? ", editable" : ""})`;
			return {
				content: [
					{
						type: "text",
						text: `${header}\n\n${md}`,
					},
				],
				details: {
					url: page.url,
					path: page.path,
					title: page.title,
					content: md,
					can_edit: page.can_edit,
					views: page.views,
				},
			};
		},
	};
}

const editSchema = Type.Object({
	label: Type.String({
		description: "Short description of what you're editing (shown to the user)",
	}),
	url_or_path: Type.String({
		description: "Full telegra.ph URL or just the path segment of the page to overwrite.",
	}),
	title: Type.String({ description: "New page title" }),
	content: Type.String({ description: "New page body in Markdown — replaces the old body entirely" }),
	author_name: Type.Optional(
		Type.String({
			description: "Override the author name shown under the title for this revision",
		}),
	),
});

/**
 * Edit an existing Telegraph page authored by this workspace's account. The
 * call replaces title and body wholesale — if you want to modify rather than
 * replace, fetch the current content via telegraph_get first and pass the
 * adjusted Markdown back in.
 */
export function createTelegraphEditTool(workspace: string): AgentTool<typeof editSchema> {
	return {
		name: "telegraph_edit",
		label: "telegraph_edit",
		description:
			"Replace the title and body of an existing Telegraph page authored by this workspace. " +
			"Editing is a wholesale overwrite, not a patch: if you want to modify rather than replace, " +
			"call telegraph_get first to fetch the current Markdown, adjust it, then call this tool with the result. " +
			"Errors if this workspace has no Telegraph account yet (publish at least one page first).",
		parameters: editSchema,
		execute: async (_toolCallId, { url_or_path, title, content, author_name }, signal) => {
			signal?.throwIfAborted();

			const account = loadAccount(workspace);
			const path = extractPath(url_or_path);
			const nodes = parse(content);
			const page = await editPage({
				access_token: account.access_token,
				path,
				title,
				content: nodes,
				...(author_name ? { author_name } : {}),
			});

			return {
				content: [
					{
						type: "text",
						text: `Updated Telegraph page: ${page.url}\n(path: ${page.path})`,
					},
				],
				details: { url: page.url, path: page.path, title: page.title },
			};
		},
	};
}

const listSchema = Type.Object({
	label: Type.String({
		description: "Short description of why you're listing (shown to the user)",
	}),
	offset: Type.Optional(
		Type.Number({ description: "Number of pages to skip (default 0)" }),
	),
	limit: Type.Optional(
		Type.Number({ description: "Max pages to return (default 50, Telegraph max 200)" }),
	),
});

/**
 * List Telegraph pages authored by this workspace's account. Useful when the
 * user asks "what have I published" or when the agent needs to recover a
 * forgotten path before calling telegraph_edit.
 */
export function createTelegraphListTool(workspace: string): AgentTool<typeof listSchema> {
	return {
		name: "telegraph_list",
		label: "telegraph_list",
		description:
			"List telegra.ph pages this workspace has published, most recent first. Returns title + URL + view count " +
			"per page so the agent can recall what's already out there or recover a path for telegraph_edit. " +
			"Errors if this workspace has no Telegraph account yet.",
		parameters: listSchema,
		execute: async (_toolCallId, { offset, limit }, signal) => {
			signal?.throwIfAborted();

			const account = loadAccount(workspace);
			const args: { access_token: string; offset?: number; limit?: number } = {
				access_token: account.access_token,
			};
			if (offset !== undefined) args.offset = offset;
			if (limit !== undefined) args.limit = limit;

			const result = await getPages(args);
			const text = formatPageList(result.total_count, result.pages);

			return {
				content: [{ type: "text", text }],
				details: {
					total_count: result.total_count,
					pages: result.pages.map((p) => ({
						path: p.path,
						url: p.url,
						title: p.title,
						views: p.views,
					})),
				},
			};
		},
	};
}

function formatPageList(
	totalCount: number,
	pages: { path: string; url: string; title: string; views: number }[],
): string {
	if (pages.length === 0) {
		return "No pages published by this workspace yet.";
	}
	const header =
		pages.length < totalCount
			? `${pages.length} of ${totalCount} pages (use offset/limit to page through):`
			: `${totalCount} page${totalCount === 1 ? "" : "s"}:`;
	const lines = pages.map(
		(p, i) => `${i + 1}. "${p.title}" — ${p.url} (${p.views} view${p.views === 1 ? "" : "s"})`,
	);
	return `${header}\n\n${lines.join("\n")}`;
}
