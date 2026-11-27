import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import type { Logger } from "./log.js";

/**
 * Sequential background download queue: a single runner draining a FIFO.
 *
 * `source` is opaque to the queue — Discord passes a CDN URL, Telegram passes
 * a `file_id`. The bot's `downloadFile` strategy decides what to do with it.
 *
 * `TLogContext` lets each bot reuse its own pi-bot-core/log logger shape so
 * download lines slot into the same per-channel / per-chat log stream as
 * everything else.
 */

export type DownloadQueueLogger<TLogContext> = Pick<Logger<TLogContext>,
	"logDownloadStart" | "logDownloadSuccess" | "logDownloadError">;

export interface DownloadItem<TLogContext> {
	/** Opaque key passed to `downloadFile` (URL, Telegram file_id, …). */
	source: string;
	/** Destination path, relative to the queue's `workingDir`. */
	localPath: string;
	/** Display name used in logs (the human-friendly "what is this file"). */
	originalName: string;
	/** Per-item logger context. */
	logContext: TLogContext;
}

export interface DownloadQueueConfig<TLogContext> {
	/** Absolute path that all `localPath`s are joined under. */
	workingDir: string;
	/** Bot-supplied transport. Must reject on failure so the runner can log it. */
	downloadFile: (source: string, destPath: string) => Promise<void>;
	log: DownloadQueueLogger<TLogContext>;
}

export class DownloadQueue<TLogContext> {
	private pending: DownloadItem<TLogContext>[] = [];
	private runner: Promise<void> | null = null;
	private workingDir: string;
	private downloadFile: DownloadQueueConfig<TLogContext>["downloadFile"];
	private log: DownloadQueueLogger<TLogContext>;

	constructor(config: DownloadQueueConfig<TLogContext>) {
		this.workingDir = config.workingDir;
		this.downloadFile = config.downloadFile;
		this.log = config.log;
	}

	/** Append an item to the queue and (lazily) start the drain runner. */
	enqueue(item: DownloadItem<TLogContext>): void {
		this.pending.push(item);
		this.kick();
	}

	/** Resolves once the currently-running drain has finished. */
	async waitForDownloads(): Promise<void> {
		while (this.runner) {
			await this.runner;
		}
	}

	private kick(): void {
		if (this.runner) return;
		this.runner = this.drain().finally(() => {
			this.runner = null;
		});
	}

	private async drain(): Promise<void> {
		while (this.pending.length > 0) {
			const item = this.pending.shift();
			if (!item) break;

			const destPath = join(this.workingDir, item.localPath);
			const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
			if (!existsSync(destDir)) {
				mkdirSync(destDir, { recursive: true });
			}

			this.log.logDownloadStart(item.logContext, item.originalName, item.localPath);
			try {
				await this.downloadFile(item.source, destPath);
				const sizeKB = Math.round(statSync(destPath).size / 1024);
				this.log.logDownloadSuccess(item.logContext, sizeKB);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				this.log.logDownloadError(item.logContext, item.originalName, msg);
			}
		}
	}
}
