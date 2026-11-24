import type { AgentTool } from "@earendil-works/pi-agent-core";
import { basename, extname } from "path";
import { obj, opt, str } from "@earendil-works/pi-schema";

/**
 * Uploader callback wired in by each ChatAgent run. Always called with the
 * path the LLM passed plus the resolved opts:
 *
 * - `label`: the brief description from the tool args (Telegram uses it as the
 *   message caption; Discord ignores it).
 * - `fileName`: explicit `title` from the tool args, or `basename(path)` when
 *   the LLM omitted it.
 *
 * The platform must validate and export the guest path through the current
 * VM sandbox turn before uploading it. Never open a guest-supplied path on the host.
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

const attachSchema = obj({
	label: str({ description: "Brief description of what you're sharing (shown to user)" }),
	path: str({ description: "Path to the file to attach" }),
	title: opt(
		str({
			description:
				"Optional filename override. Must include the file extension (e.g. 'report.pdf', 'memory.md'); the extension drives how the platform renders or downloads the file. Defaults to the basename of `path`.",
		}),
	),
}, { open: true });

/**
 * Build the `attach` tool for a single ChatAgent instance.
 *
 * Ported from pi-mom (pi-mono/packages/mom/src/tools/attach.ts). Intentional
 * deviations:
 * - Factory + per-instance setUploader replaces mom's module-level singleton
 *   so that chats running in parallel cannot clobber each other's uploader.
 * - Uploader signature carries `{ label, fileName }`; the bot decides what to
 *   do with `label` (Telegram uses it as caption, Discord ignores).
 * - Rejects relative paths before calling the uploader. The active VM sandbox
 *   turn enforces allowed guest directories when the uploader exports the file.
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

			const fileName = resolveFileName(path, title);

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

/**
 * Pick the upload filename. When the LLM supplies `title`, use it; if it forgot
 * the extension and `path` has one, splice the path's extension on so the
 * platform (Discord, Telegram) still renders/downloads the file as the right
 * type. Without this, an LLM that interprets `title` as a human-readable
 * caption (e.g. `"memory"` for `MEMORY.md`) ships an extension-less blob.
 *
 * Exported for unit testing.
 */
export function resolveFileName(path: string, title?: string): string {
	if (!title) return basename(path);
	if (extname(title)) return title;
	const pathExt = extname(path);
	return pathExt ? `${title}${pathExt}` : title;
}
