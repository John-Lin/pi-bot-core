import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { ensureTelegraphAccount } from "../telegraph/account.js";
import { createPage } from "../telegraph/client.js";
import { parse } from "../telegraph/parser.js";

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
