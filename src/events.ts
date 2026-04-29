import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "./fs-watch.js";
import type { ScheduleEventType } from "./tools/schedule.js";

/**
 * Generic event scheduler.
 *
 * Tails `${eventsDir}/*.json`. Each file is one scheduled event in one of
 * three flavours:
 *
 * - immediate: fire on detection, then unlink. For webhook/script signals.
 * - one-shot:  setTimeout to event.at, fire then unlink.
 * - periodic:  Cron-driven, file persists until the user removes it.
 *
 * Platform specifics (chatId/channelId/threadId, JSON validation, queue
 * keying) are injected by the caller via {@link EventsPolicy}. The watcher
 * itself is platform-agnostic.
 */

// ============================================================================
// Public types
// ============================================================================

/** Common shape every scheduled event must satisfy. Routing fields live in TEvent. */
export interface ScheduledEventCommon {
	type: ScheduleEventType;
	/**
	 * Synthetic user message. Note: when delivered via {@link FiredEvent} the
	 * dispatcher receives a prefixed form (`[EVENT:name:type:schedule] ...`),
	 * not this raw value.
	 */
	text: string;
	/** Required for type='one-shot'. ISO 8601. */
	at?: string;
	/** Required for type='periodic'. Cron syntax. */
	schedule?: string;
	/** Required for type='periodic'. IANA timezone. */
	timezone?: string;
}

/**
 * What the dispatcher receives. The original parsed event fields are spread
 * verbatim, so `event.channelId` / `event.chatId` / `event.threadId` etc.
 * remain accessible.
 */
export type FiredEvent<TEvent extends ScheduledEventCommon> = TEvent & {
	/** JSON filename, used in the [EVENT:...] prefix. */
	name: string;
	/**
	 * **Replaces** the original `text` from `TEvent` with the prefixed form
	 * `[EVENT:name:type:schedule] <original text>`. Dispatchers that need the
	 * raw user message must strip the prefix themselves.
	 */
	text: string;
};

export type EventDispatcher<TEvent extends ScheduledEventCommon> = (
	event: FiredEvent<TEvent>,
) => Promise<void>;

export interface EventsLogger {
	info(msg: string): void;
	warn(msg: string, detail?: string): void;
}

export interface EventsPolicy<TEvent extends ScheduledEventCommon> {
	/** Validate JSON contents, return a typed event or throw. */
	parse: (content: string, filename: string) => TEvent;
	/**
	 * Returns the queue-depth bucket key for this event. Used to cap concurrent
	 * fan-out per chat/channel so a runaway cron doesn't drown one chat in
	 * messages.
	 */
	queueKey: (event: TEvent) => string | number;
	/** Optional structured logger. Defaults to console.{info,warn}. */
	log?: EventsLogger;
}

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;
const MAX_QUEUED = 5;

const consoleLogger: EventsLogger = {
	info: (msg) => console.log(msg),
	warn: (msg, detail) => console.warn(detail ? `${msg}: ${detail}` : msg),
};

export class EventsWatcher<TEvent extends ScheduledEventCommon> {
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private crons: Map<string, Cron> = new Map();
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private startTime: number;
	private watcher: FSWatcher | null = null;
	private watcherRetryTimer: NodeJS.Timeout | null = null;
	private knownFiles: Set<string> = new Set();
	private stopped = true;
	/** Per-target queue depth, capped by MAX_QUEUED to bound spam. */
	private queueDepth: Map<string | number, number> = new Map();
	private log: EventsLogger;

	constructor(
		private eventsDir: string,
		private dispatcher: EventDispatcher<TEvent>,
		private policy: EventsPolicy<TEvent>,
	) {
		this.startTime = Date.now();
		this.log = policy.log ?? consoleLogger;
	}

	start(): void {
		this.stopped = false;

		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}

		this.log.info(`Events watcher starting, dir: ${this.eventsDir}`);
		this.scanExisting();
		this.startFsWatcher();
		this.log.info(`Events watcher started, tracking ${this.knownFiles.size} files`);
	}

	stop(): void {
		this.stopped = true;

		closeWatcher(this.watcher);
		this.watcher = null;
		if (this.watcherRetryTimer) {
			clearTimeout(this.watcherRetryTimer);
			this.watcherRetryTimer = null;
		}

		for (const timer of this.debounceTimers.values()) clearTimeout(timer);
		this.debounceTimers.clear();

		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();

		for (const cron of this.crons.values()) cron.stop();
		this.crons.clear();

		this.knownFiles.clear();
		this.queueDepth.clear();
		this.log.info("Events watcher stopped");
	}

	private startFsWatcher(): void {
		this.watcher = watchWithErrorHandler(
			this.eventsDir,
			(_eventType, filename) => {
				if (!filename || !filename.endsWith(".json")) return;
				this.debounce(filename, () => this.handleFileChange(filename));
			},
			() => this.handleFsWatcherError(),
		);
	}

	private handleFsWatcherError(): void {
		closeWatcher(this.watcher);
		this.watcher = null;
		this.scheduleFsWatcherRetry();
	}

	private scheduleFsWatcherRetry(): void {
		if (this.stopped || this.watcherRetryTimer) return;
		this.watcherRetryTimer = setTimeout(() => {
			this.watcherRetryTimer = null;
			if (this.stopped) return;
			this.startFsWatcher();
			if (this.watcher) this.rescanExisting();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private debounce(filename: string, fn: () => void): void {
		const existing = this.debounceTimers.get(filename);
		if (existing) clearTimeout(existing);
		this.debounceTimers.set(
			filename,
			setTimeout(() => {
				this.debounceTimers.delete(filename);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	private scanExisting(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			this.log.warn("Failed to read events directory", String(err));
			return;
		}
		for (const filename of files) this.handleFile(filename);
	}

	private rescanExisting(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			this.log.warn("Failed to read events directory", String(err));
			return;
		}
		const currentFiles = new Set(files);
		for (const filename of files) this.handleFileChange(filename);
		for (const filename of Array.from(this.knownFiles)) {
			if (!currentFiles.has(filename)) this.handleDelete(filename);
		}
	}

	private handleFileChange(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		if (!existsSync(filePath)) {
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			this.cancelScheduled(filename);
			this.handleFile(filename);
		} else {
			this.handleFile(filename);
		}
	}

	private handleDelete(filename: string): void {
		if (!this.knownFiles.has(filename)) return;
		this.log.info(`Event file deleted: ${filename}`);
		this.cancelScheduled(filename);
		this.knownFiles.delete(filename);
	}

	private cancelScheduled(filename: string): void {
		const timer = this.timers.get(filename);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(filename);
		}
		const cron = this.crons.get(filename);
		if (cron) {
			cron.stop();
			this.crons.delete(filename);
		}
	}

	private async handleFile(filename: string): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		// Parse with retries — fs.watch may fire mid-write.
		let event: TEvent | null = null;
		let lastError: Error | null = null;

		for (let i = 0; i < MAX_RETRIES; i++) {
			try {
				const content = await readFile(filePath, "utf-8");
				event = this.policy.parse(content, filename);
				break;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (i < MAX_RETRIES - 1) await sleep(RETRY_BASE_MS * 2 ** i);
			}
		}

		if (!event) {
			this.log.warn(
				`Failed to parse event file after ${MAX_RETRIES} retries: ${filename}`,
				lastError?.message,
			);
			this.deleteFile(filename);
			return;
		}

		this.knownFiles.add(filename);

		switch (event.type) {
			case "immediate":
				this.handleImmediate(filename, event);
				break;
			case "one-shot":
				this.handleOneShot(filename, event);
				break;
			case "periodic":
				this.handlePeriodic(filename, event);
				break;
		}
	}

	private handleImmediate(filename: string, event: TEvent): void {
		const filePath = join(this.eventsDir, filename);
		// Skip stale immediates (file existed before watcher startup).
		try {
			const stat = statSync(filePath);
			if (stat.mtimeMs < this.startTime) {
				this.log.info(`Stale immediate event, deleting: ${filename}`);
				this.deleteFile(filename);
				return;
			}
		} catch {
			return;
		}
		this.log.info(`Executing immediate event: ${filename}`);
		void this.execute(filename, event);
	}

	private handleOneShot(filename: string, event: TEvent): void {
		if (!event.at) {
			this.log.warn(`One-shot event missing 'at', deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}
		const atTime = new Date(event.at).getTime();
		const now = Date.now();
		if (atTime <= now) {
			this.log.info(`One-shot event in the past, deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}
		const delay = atTime - now;
		this.log.info(`Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s`);
		const timer = setTimeout(() => {
			this.timers.delete(filename);
			this.log.info(`Executing one-shot event: ${filename}`);
			void this.execute(filename, event);
		}, delay);
		this.timers.set(filename, timer);
	}

	private handlePeriodic(filename: string, event: TEvent): void {
		if (!event.schedule || !event.timezone) {
			this.log.warn(`Periodic event missing schedule/timezone, deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}
		try {
			const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
				this.log.info(`Executing periodic event: ${filename}`);
				void this.execute(filename, event, false);
			});
			this.crons.set(filename, cron);
			const next = cron.nextRun();
			this.log.info(
				`Scheduled periodic event: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`,
			);
		} catch (err) {
			this.log.warn(`Invalid cron schedule for ${filename}: ${event.schedule}`, String(err));
			this.deleteFile(filename);
		}
	}

	private async execute(filename: string, event: TEvent, deleteAfter: boolean = true): Promise<void> {
		const scheduleInfo =
			event.type === "immediate"
				? "immediate"
				: event.type === "one-shot"
					? event.at
					: event.schedule;
		const text = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;

		const key = this.policy.queueKey(event);
		const depth = this.queueDepth.get(key) ?? 0;
		if (depth >= MAX_QUEUED) {
			this.log.warn(
				`Event queue full for ${key}, discarding: ${event.text.substring(0, 50)}`,
			);
			if (deleteAfter) this.deleteFile(filename);
			return;
		}

		this.queueDepth.set(key, depth + 1);
		if (deleteAfter) this.deleteFile(filename);

		try {
			await this.dispatcher({ ...event, name: filename, text } as FiredEvent<TEvent>);
		} catch (err) {
			this.log.warn(
				`Dispatcher failed for event ${filename}`,
				err instanceof Error ? err.message : String(err),
			);
		} finally {
			const remaining = (this.queueDepth.get(key) ?? 1) - 1;
			if (remaining <= 0) this.queueDepth.delete(key);
			else this.queueDepth.set(key, remaining);
		}
	}

	private deleteFile(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		try {
			unlinkSync(filePath);
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
				this.log.warn(`Failed to delete event file: ${filename}`, String(err));
			}
		}
		this.knownFiles.delete(filename);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convenience constructor: opens the watcher in `${workspaceDir}/events/`. */
export function createEventsWatcher<TEvent extends ScheduledEventCommon>(
	workspaceDir: string,
	dispatcher: EventDispatcher<TEvent>,
	policy: EventsPolicy<TEvent>,
): EventsWatcher<TEvent> {
	return new EventsWatcher(join(workspaceDir, "events"), dispatcher, policy);
}
