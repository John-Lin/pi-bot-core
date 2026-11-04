import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	type FSWatcher,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { EventsWatcher, type FiredEvent, type ScheduledEventCommon } from "../src/events.js";

interface TestEvent extends ScheduledEventCommon {
	chatId: number;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Observe real asynchronous work so assertions run after its continuations settle.
type WatcherWork = {
	handleFile(filename: string, generation?: number): Promise<void>;
	execute(filename: string, event: TestEvent, ...args: unknown[]): Promise<void>;
};

let tempDir: string;
let eventsDir: string;
let watcher: EventsWatcher<TestEvent>;
let dispatched: FiredEvent<TestEvent>[];
let warnings: string[];
let parsed: string[];
let parseAttempt: ReturnType<typeof deferred>;
let dispatcherDone: ReturnType<typeof deferred> | undefined;
let readSpy: ReturnType<typeof spyOn<typeof fsPromises, "readFile">> | undefined;
let fileWork: ReturnType<typeof spyOn<WatcherWork, "handleFile">>;
let dispatchWork: ReturnType<typeof spyOn<WatcherWork, "execute">>;
let readGates: ReturnType<typeof deferred>[];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-bot-events-lifecycle-"));
	eventsDir = join(tempDir, "events");
	mkdirSync(eventsDir);
	dispatched = [];
	warnings = [];
	parsed = [];
	parseAttempt = deferred();
	dispatcherDone = undefined;
	readGates = [];
	watcher = new EventsWatcher<TestEvent>(
		eventsDir,
		async (event) => {
			dispatched.push(event);
			appendFileSync(join(eventsDir, "dispatch.log"), `${event.name}\n`);
			await dispatcherDone?.promise;
		},
		{
			parse: (content) => {
				parsed.push(content);
				parseAttempt.resolve();
				return JSON.parse(content) as TestEvent;
			},
			queueKey: (event) => event.chatId,
			log: {
				info: () => {},
				warn: (msg, detail) => warnings.push(detail ? `${msg}: ${detail}` : msg),
			},
		},
	);
	const work = watcher as unknown as WatcherWork;
	fileWork = spyOn(work, "handleFile");
	dispatchWork = spyOn(work, "execute");
});

afterEach(async () => {
	watcher.stop();
	for (const gate of readGates) gate.resolve();
	dispatcherDone?.resolve();
	await settleFiles();
	await settleDispatches();
	readSpy?.mockRestore();
	readSpy = undefined;
	fileWork.mockRestore();
	dispatchWork.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

function writeEvent(filename: string, event: Partial<TestEvent> = {}): string {
	const filePath = join(eventsDir, filename);
	writeFileSync(
		filePath,
		JSON.stringify({ type: "immediate", chatId: 123, text: filename, ...event }),
	);
	return filePath;
}

function pauseRead(filename: string) {
	const entered = deferred();
	const release = deferred();
	readGates.push(release);
	const originalRead = fsPromises.readFile;
	let paused = false;
	readSpy = spyOn(fsPromises, "readFile").mockImplementation((async (
		...args: Parameters<typeof fsPromises.readFile>
	) => {
		const content = await originalRead(...args);
		if (!paused && args[0] === join(eventsDir, filename)) {
			paused = true;
			entered.resolve();
			await release.promise;
		}
		return content;
	}) as typeof fsPromises.readFile);
	return { entered: entered.promise, release: release.resolve };
}

async function settleFiles(): Promise<void> {
	await Promise.all(fileWork.mock.results.map((result) => result.value));
}

async function settleDispatches(): Promise<void> {
	await Promise.all(dispatchWork.mock.results.map((result) => result.value));
}

function expectNoDispatch(): void {
	expect(dispatched).toEqual([]);
	expect(existsSync(join(eventsDir, "dispatch.log"))).toBe(false);
}

function expectNoSchedules(): void {
	expect((Reflect.get(watcher, "knownFiles") as Set<string>).size).toBe(0);
	expect((Reflect.get(watcher, "timers") as Map<string, unknown>).size).toBe(0);
	expect((Reflect.get(watcher, "crons") as Map<string, unknown>).size).toBe(0);
}

describe("EventsWatcher lifecycle ownership", () => {
	test("start retries failed directory preparation without an intervening stop", async () => {
		rmSync(tempDir, { recursive: true });
		writeFileSync(tempDir, "not a directory");
		expect(() => watcher.start()).toThrow(/ENOTDIR/);

		rmSync(tempDir);
		mkdirSync(eventsDir, { recursive: true });
		const filePath = writeEvent("retry-start.json");
		watcher.start();
		await settleFiles();

		expect(dispatched).toEqual([
			{
				type: "immediate",
				chatId: 123,
				name: "retry-start.json",
				text: "[EVENT:retry-start.json:immediate:immediate] retry-start.json",
			},
		]);
		expect(readFileSync(join(eventsDir, "dispatch.log"), "utf-8")).toBe("retry-start.json\n");
		expect(existsSync(filePath)).toBe(false);
		expect(warnings).toEqual([]);
	});

	for (const event of [
		{ type: "immediate" as const },
		{ type: "one-shot" as const, at: new Date(Date.now() + 60_000).toISOString() },
		{ type: "periodic" as const, schedule: "* * * * *", timezone: "UTC" },
	]) {
		test(`stop during a pending read prevents late ${event.type} work`, async () => {
			const filePath = writeEvent("pending.json", event);
			const read = pauseRead("pending.json");
			watcher.start();
			await read.entered;
			watcher.stop();
			read.release();
			await settleFiles();

			expect(existsSync(filePath)).toBe(true);
			expectNoDispatch();
			expectNoSchedules();
			expect(warnings).toEqual([]);
		});
	}

	test("stop during a parse retry leaves an invalid file untouched and stops further reads", async () => {
		const filePath = join(eventsDir, "partial.json");
		writeFileSync(filePath, "{");
		watcher.start();
		await parseAttempt.promise;
		watcher.stop();
		await settleFiles();

		expect(readFileSync(filePath, "utf-8")).toBe("{");
		expect(parsed).toEqual(["{"]);
		expectNoDispatch();
		expectNoSchedules();
		expect(warnings).toEqual([]);
	});

	test("stop during a parse retry does not dispatch or delete a subsequently completed signal", async () => {
		const filePath = join(eventsDir, "partial.json");
		writeFileSync(filePath, "{");
		watcher.start();
		await parseAttempt.promise;
		watcher.stop();
		writeEvent("partial.json");
		await settleFiles();

		expect(existsSync(filePath)).toBe(true);
		expect(parsed).toEqual(["{"]);
		expectNoDispatch();
		expectNoSchedules();
		expect(warnings).toEqual([]);
	});

	for (const staleType of ["immediate", "one-shot", "periodic"] as const) {
		test(`stop then start rejects a stale ${staleType} read without changing the new schedule`, async () => {
			const filePath = writeEvent("restart.json", {
				type: staleType,
				...(staleType === "one-shot" ? { at: new Date(Date.now() + 60_000).toISOString() } : {}),
				...(staleType === "periodic" ? { schedule: "* * * * *", timezone: "UTC" } : {}),
			});
			const read = pauseRead("restart.json");
			watcher.start();
			await read.entered;
			watcher.stop();
			writeEvent("restart.json", {
				type: "one-shot",
				at: new Date(Date.now() + 60_000).toISOString(),
			});
			watcher.start();
			// Only the new lifecycle's read can finish while the old one is paused.
			await fileWork.mock.results[1]!.value;
			const timers = Reflect.get(watcher, "timers") as Map<string, NodeJS.Timeout>;
			const timer = timers.get("restart.json");
			expect(timer).toBeDefined();
			read.release();
			await settleFiles();

			expect(existsSync(filePath)).toBe(true);
			expect(timers.get("restart.json")).toBe(timer);
			expect((Reflect.get(watcher, "knownFiles") as Set<string>).has("restart.json")).toBe(true);
			expect((Reflect.get(watcher, "crons") as Map<string, unknown>).size).toBe(0);
			expectNoDispatch();
			expect(warnings).toEqual([]);
		});
	}

	test("stop then start rejects a stale parse retry", async () => {
		const filePath = join(eventsDir, "retry.json");
		writeFileSync(filePath, "{");
		watcher.start();
		await parseAttempt.promise;
		watcher.stop();
		writeEvent("retry.json", { type: "one-shot", at: new Date(Date.now() + 60_000).toISOString() });
		watcher.start();
		await fileWork.mock.results[1]!.value;
		const timers = Reflect.get(watcher, "timers") as Map<string, NodeJS.Timeout>;
		const timer = timers.get("retry.json");
		await settleFiles();
		expect(timers.get("retry.json")).toBe(timer);
		expect(parsed).toHaveLength(2);
		expect(existsSync(filePath)).toBe(true);
		expectNoDispatch();
		expect(warnings).toEqual([]);
	});

	test("old dispatcher completion cannot free a slot in the restarted lifecycle", async () => {
		const oldDone = deferred();
		dispatcherDone = oldDone;
		writeEvent("old.json");
		watcher.start();
		await settleFiles();
		expect(dispatched.map((event) => event.name)).toEqual(["old.json"]);
		watcher.stop();

		dispatcherDone = deferred();
		for (let i = 0; i < 5; i++) writeEvent(`new-${i}.json`);
		watcher.start();
		await settleFiles();
		expect(dispatched).toHaveLength(6);
		oldDone.resolve();
		await dispatchWork.mock.results[0]!.value;

		const overflowPath = writeEvent("overflow.json");
		await waitFor(() => !existsSync(overflowPath));
		expect(dispatched).toHaveLength(6);
		expect(readFileSync(join(eventsDir, "dispatch.log"), "utf-8").trim().split("\n")).toHaveLength(
			6,
		);
		expect(warnings).toEqual(["Event queue full for 123, discarding: overflow.json"]);
	});

	test("stop does not cancel dispatcher I/O that already began", async () => {
		dispatcherDone = deferred();
		const filePath = writeEvent("started.json");
		watcher.start();
		await settleFiles();
		watcher.stop();
		expect(existsSync(filePath)).toBe(false);
		expect(readFileSync(join(eventsDir, "dispatch.log"), "utf-8")).toBe("started.json\n");
		dispatcherDone.resolve();
		await settleDispatches();
		expect((Reflect.get(watcher, "queueDepth") as Map<number, number>).size).toBe(0);
		expect(warnings).toEqual([]);
	});

	test("a closed watcher's late error cannot close the restarted watcher", async () => {
		watcher.start();
		const oldFsWatcher = Reflect.get(watcher, "watcher") as FSWatcher;
		watcher.stop();
		watcher.start();
		const currentFsWatcher = Reflect.get(watcher, "watcher") as FSWatcher;
		oldFsWatcher.emit("error", new Error("late watcher error"));
		expect(Reflect.get(watcher, "watcher")).toBe(currentFsWatcher);
		const filePath = writeEvent("live.json");
		await waitFor(() => !existsSync(filePath));
		expect(readFileSync(join(eventsDir, "dispatch.log"), "utf-8")).toBe("live.json\n");
		expect(warnings).toEqual([]);
	});

	test("starting an active lifecycle does not replace its watcher or duplicate dispatch", async () => {
		const filePath = writeEvent("once.json");
		const read = pauseRead("once.json");
		watcher.start();
		await read.entered;
		const fsWatcher = Reflect.get(watcher, "watcher") as FSWatcher;
		watcher.start();
		const startedWatcher = Reflect.get(watcher, "watcher") as FSWatcher;
		// Close the first handle even if the repeated-start regression fails.
		fsWatcher.close();
		expect(startedWatcher).toBe(fsWatcher);
		read.release();
		await settleFiles();
		expect(existsSync(filePath)).toBe(false);
		expect(readFileSync(join(eventsDir, "dispatch.log"), "utf-8")).toBe("once.json\n");
		expect(dispatched).toHaveLength(1);
		expect(warnings).toEqual([]);
	});

	test("active one-shot and cron schedules dispatch normally and stop removes both", async () => {
		writeEvent("once.json", { type: "one-shot", at: new Date(Date.now() + 200).toISOString() });
		const cronPath = writeEvent("repeat.json", {
			type: "periodic",
			schedule: "* * * * * *",
			timezone: "UTC",
		});
		watcher.start();
		await settleFiles();
		await waitFor(
			() =>
				dispatched.some((event) => event.name === "once.json") &&
				dispatched.some((event) => event.name === "repeat.json"),
		);
		watcher.stop();
		expect(existsSync(join(eventsDir, "once.json"))).toBe(false);
		expect(existsSync(cronPath)).toBe(true);
		expect(readFileSync(join(eventsDir, "dispatch.log"), "utf-8")).toContain("once.json\n");
		expectNoSchedules();
		expect(warnings).toEqual([]);
	});
});

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!condition() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(condition()).toBe(true);
}
