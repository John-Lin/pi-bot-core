import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { readFile } from "fs/promises";
import { basename, join } from "path";
import { fsErrorCode } from "./fs-errors.js";
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
 * What the dispatcher receives. The watcher sets `name` and prefixes `text`;
 * other parsed fields such as `channelId`, `chatId`, or `threadId` are preserved.
 */
export type FiredEvent<TEvent extends ScheduledEventCommon> = {
	[Field in keyof TEvent as Exclude<Field, "name" | "text">]: TEvent[Field];
} & {
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
	/** Optional logger. Defaults to stdout for info and stderr for warnings. */
	log?: EventsLogger;
}

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;
const MAX_QUEUED = 5;
const MAX_TIMEOUT_MS = 2_147_483_647;
const IMMEDIATE_STALE_TOLERANCE_MS = 5 * 60 * 1000;

type EventFilename = string & { readonly __brand: "EventFilename" };

function isEventFilename(value: string | null): value is EventFilename {
	return value !== null && value.endsWith(".json") && basename(value) === value && !value.includes("\0");
}

const terminalLogger: EventsLogger = {
	info: (msg) => { process.stdout.write(`${msg}\n`); },
	warn: (msg, detail) => { process.stderr.write(detail ? `${msg}: ${detail}\n` : `${msg}\n`); },
};

export class EventsWatcher<TEvent extends ScheduledEventCommon> {
	private timers: Map<EventFilename, NodeJS.Timeout> = new Map();
	private crons: Map<EventFilename, Cron> = new Map();
	private debounceTimers: Map<EventFilename, NodeJS.Timeout> = new Map();
	private startTime: number;
	private watcher: FSWatcher | null = null;
	private watcherRetryTimer: NodeJS.Timeout | null = null;
	private knownFiles: Set<EventFilename> = new Set();
	private stopped = true;
	/** Identifies the start/stop lifecycle that owns asynchronous work. */
	private generation = 0;
	/** Per-target queue depth, capped by MAX_QUEUED to bound spam. */
	private queueDepth: Map<string | number, number> = new Map();
	private log: EventsLogger;

	constructor(
		private eventsDir: string,
		private dispatcher: EventDispatcher<TEvent>,
		private policy: EventsPolicy<TEvent>,
	) {
		this.startTime = Date.now();
		this.log = policy.log ?? terminalLogger;
	}

	start(): void {
		if (!this.stopped) return;

		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}

		this.log.info(`Events watcher starting, dir: ${this.eventsDir}`);
		this.stopped = false;
		const generation = ++this.generation;
		this.scanExisting(generation);
		this.startFsWatcher(generation);
		this.log.info(`Events watcher started, tracking ${this.knownFiles.size} files`);
	}

	/**
	 * Prevent new dispatch, scheduling, and file side effects from this lifecycle.
	 * Dispatcher I/O already started is not cancelled; its cleanup cannot affect a restart.
	 */
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

	private isActive(generation: number): boolean {
		return !this.stopped && generation === this.generation;
	}

	private startFsWatcher(generation: number): void {
		if (!this.isActive(generation)) return;
		this.watcher = watchWithErrorHandler(
			this.eventsDir,
			(_eventType, filename) => {
				if (!isEventFilename(filename)) return;
				this.debounce(filename, generation, () => this.handleFileChange(filename, generation));
			},
			() => this.handleFsWatcherError(generation),
		);
	}

	private handleFsWatcherError(generation: number): void {
		if (!this.isActive(generation)) return;
		closeWatcher(this.watcher);
		this.watcher = null;
		this.scheduleFsWatcherRetry(generation);
	}

	private scheduleFsWatcherRetry(generation: number): void {
		if (!this.isActive(generation) || this.watcherRetryTimer) return;
		this.watcherRetryTimer = setTimeout(() => {
			if (!this.isActive(generation)) return;
			this.watcherRetryTimer = null;
			this.startFsWatcher(generation);
			if (this.watcher) this.rescanExisting(generation);
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private debounce(filename: EventFilename, generation: number, fn: () => void): void {
		if (!this.isActive(generation)) return;
		const existing = this.debounceTimers.get(filename);
		if (existing) clearTimeout(existing);
		this.debounceTimers.set(
			filename,
			setTimeout(() => {
				if (!this.isActive(generation)) return;
				this.debounceTimers.delete(filename);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	private scanExisting(generation: number): void {
		if (!this.isActive(generation)) return;
		let files: EventFilename[];
		try {
			files = readdirSync(this.eventsDir).filter(isEventFilename);
		} catch (err) {
			this.log.warn("Failed to read events directory", String(err));
			return;
		}
		for (const filename of files) this.handleFile(filename, generation);
	}

	private rescanExisting(generation: number): void {
		if (!this.isActive(generation)) return;
		let files: EventFilename[];
		try {
			files = readdirSync(this.eventsDir).filter(isEventFilename);
		} catch (err) {
			this.log.warn("Failed to read events directory", String(err));
			return;
		}
		const currentFiles = new Set(files);
		for (const filename of files) this.handleFileChange(filename, generation);
		for (const filename of Array.from(this.knownFiles)) {
			if (!currentFiles.has(filename)) this.handleDelete(filename);
		}
	}

	private handleFileChange(filename: EventFilename, generation: number): void {
		if (!this.isActive(generation)) return;
		const filePath = join(this.eventsDir, filename);
		if (!existsSync(filePath)) {
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			this.cancelScheduled(filename);
			this.handleFile(filename, generation);
		} else {
			this.handleFile(filename, generation);
		}
	}

	private handleDelete(filename: EventFilename): void {
		if (!this.knownFiles.has(filename)) return;
		this.log.info(`Event file deleted: ${filename}`);
		this.cancelScheduled(filename);
		this.knownFiles.delete(filename);
	}

	private cancelScheduled(filename: EventFilename): void {
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

	private async handleFile(filename: EventFilename, generation: number): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		// Parse with retries — fs.watch may fire mid-write.
		let event: TEvent | null = null;
		let lastError: Error | null = null;

		for (let i = 0; i < MAX_RETRIES; i++) {
			if (!this.isActive(generation)) return;
			try {
				const content = await readFile(filePath, "utf-8");
				if (!this.isActive(generation)) return;
				event = this.policy.parse(content, filename);
				break;
			} catch (err) {
				if (!this.isActive(generation)) return;
				lastError = err instanceof Error ? err : new Error(String(err));
				if (i < MAX_RETRIES - 1) await sleep(RETRY_BASE_MS * 2 ** i);
			}
		}

		if (!this.isActive(generation)) return;
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
				this.handleImmediate(filename, event, generation);
				break;
			case "one-shot":
				this.handleOneShot(filename, event, generation);
				break;
			case "periodic":
				this.handlePeriodic(filename, event, generation);
				break;
			default: {
				const _exhaustive: never = event.type;
				void _exhaustive;
			}
		}
	}

	private handleImmediate(filename: EventFilename, event: TEvent, generation: number): void {
		const filePath = join(this.eventsDir, filename);
		// Allow recent pre-start signals so short outages don't discard them.
		try {
			const stat = statSync(filePath);
			if (stat.mtimeMs < this.startTime - IMMEDIATE_STALE_TOLERANCE_MS) {
				this.log.info(`Stale immediate event, deleting: ${filename}`);
				this.deleteFile(filename);
				return;
			}
		} catch {
			return;
		}
		this.log.info(`Executing immediate event: ${filename}`);
		void this.execute(filename, event, generation);
	}

	private handleOneShot(filename: EventFilename, event: TEvent, generation: number): void {
		if (!event.at) {
			this.log.warn(`One-shot event missing 'at', deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}
		const atTime = Date.parse(event.at);
		if (Number.isNaN(atTime)) {
			this.log.warn(`One-shot event has an invalid 'at', deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}
		const delay = atTime - Date.now();
		if (delay <= 0) {
			this.log.info(`One-shot event in the past, deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}
		this.log.info(`Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s`);
		// Longer delays overflow the native timer. Recheck the wall-clock deadline at each wakeup.
		const arm = (remaining: number): void => {
			const timer = setTimeout(() => {
				if (!this.isActive(generation)) return;
				const untilDeadline = atTime - Date.now();
				if (untilDeadline > 0) {
					arm(untilDeadline);
					return;
				}
				this.timers.delete(filename);
				this.log.info(`Executing one-shot event: ${filename}`);
				void this.execute(filename, event, generation);
			}, Math.min(remaining, MAX_TIMEOUT_MS));
			this.timers.set(filename, timer);
		};
		arm(delay);
	}

	private handlePeriodic(filename: EventFilename, event: TEvent, generation: number): void {
		if (!event.schedule || !event.timezone) {
			this.log.warn(`Periodic event missing schedule/timezone, deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}
		try {
			const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
				if (!this.isActive(generation)) return;
				this.log.info(`Executing periodic event: ${filename}`);
				void this.execute(filename, event, generation);
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

	private async execute(filename: EventFilename, event: TEvent, generation: number): Promise<void> {
		if (!this.isActive(generation)) return;
		const deleteAfter = event.type !== "periodic";
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
			await this.dispatcher({ ...event, name: filename, text });
		} catch (err) {
			this.log.warn(
				`Dispatcher failed for event ${filename}`,
				err instanceof Error ? err.message : String(err),
			);
		} finally {
			if (this.isActive(generation)) {
				const remaining = (this.queueDepth.get(key) ?? 1) - 1;
				if (remaining <= 0) this.queueDepth.delete(key);
				else this.queueDepth.set(key, remaining);
			}
		}
	}

	private deleteFile(filename: EventFilename): void {
		const filePath = join(this.eventsDir, filename);
		try {
			unlinkSync(filePath);
		} catch (err) {
			if (fsErrorCode(err) !== "ENOENT") {
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
