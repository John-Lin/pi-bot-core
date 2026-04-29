import type { AgentTool } from "@mariozechner/pi-agent-core";
import { basename } from "path";
import { Type } from "typebox";

/**
 * Uploader callback wired in by each ChatAgent run. Always called with the
 * path the LLM passed plus the resolved opts:
 *
 * - `label`: the brief description from the tool args (Telegram uses it as the
 *   message caption; Discord ignores it).
 * - `fileName`: explicit `title` from the tool args, or `basename(path)` when
 *   the LLM omitted it.
 *
 * Path translation (container → host) and existence checks are the platform
 * layer's responsibility — by the time this fires, `filePath` is whatever the
 * LLM called the tool with (typically still in container form), so the bot's
 * `setUploader` callback should resolve to a host path before doing IO.
 */
export type AttachUploader = (
	filePath: string,
	opts: { label: string; fileName: string },
) => Promise<void>;

export interface AttachToolHandle {
	tool: AgentTool<typeof attachSchema>;
	/** Set or clear the uploader for the next/current run. */
	setUploader(fn: AttachUploader | null): void;
}

const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

/**
 * Build the `attach` tool for a single ChatAgent instance.
 *
 * Ported from pi-mom (pi-mono/packages/mom/src/tools/attach.ts). Intentional
 * deviations:
 * - Factory + per-instance setUploader replaces mom's module-level singleton
 *   so that chats running in parallel cannot clobber each other's uploader.
 * - Uploader signature carries `{ label, fileName }`; the bot decides what to
 *   do with `label` (Telegram uses it as caption, Discord ignores).
 * - Rejects non-absolute paths before calling the uploader. pi-mom's
 *   `path.resolve(path)` is a no-op on absolute paths but silently resolves
 *   relative ones against the process CWD, which then surfaces as a generic
 *   "file not found" from the host-side translator. We stop at "must be
 *   absolute" rather than requiring `/workspace/` because bots support host
 *   mode, where the workspace root is a real host path (e.g. `/Users/.../data`).
 *
 * Note: containment (path must live under the workspace root) is NOT
 * currently enforced — any absolute path that exists on the host can be
 * attached. Agents are trusted to follow the tool description.
 */
export function createAttachTool(): AttachToolHandle {
	let uploader: AttachUploader | null = null;

	const tool: AgentTool<typeof attachSchema> = {
		name: "attach",
		label: "attach",
		description:
			"Attach a file to your response. Use this to share files, images, or documents with the user. The path must be absolute and should point to a file under your workspace root.",
		parameters: attachSchema,
		execute: async (
			_toolCallId: string,
			{ label, path, title }: { label: string; path: string; title?: string },
			signal?: AbortSignal,
		) => {
			signal?.throwIfAborted();

			if (!uploader) {
				throw new Error("attach: no active upload session (uploader not configured)");
			}

			if (!path.startsWith("/")) {
				throw new Error(`attach: path must be absolute, got: ${path}`);
			}

			const fileName = title || basename(path);

			await uploader(path, { label, fileName });

			return {
				content: [{ type: "text" as const, text: `Attached ${fileName}` }],
				details: undefined,
			};
		},
	};

	return {
		tool,
		setUploader(fn) {
			uploader = fn;
		},
	};
}
