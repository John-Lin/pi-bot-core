import { type FSWatcher, type WatchListener, watch } from "node:fs";

/**
 * macOS `fs.watch` is unreliable — it can silently die after the underlying
 * inode rotates (e.g. an editor "save" that writes to a temp file then
 * renames). This module wraps `watch()` with an error hook so callers can
 * tear down + recreate the watcher and re-scan the directory.
 *
 * Ported from pi-mono/packages/mom/src/fs-watch.ts.
 */

export const FS_WATCH_RETRY_DELAY_MS = 5000;

export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	if (!watcher) return;
	try {
		watcher.close();
	} catch {
		// Ignore watcher close errors
	}
}

export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: () => void,
): FSWatcher | null {
	try {
		const watcher = watch(path, listener);
		watcher.on("error", onError);
		return watcher;
	} catch {
		onError();
		return null;
	}
}
