import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventsWatcher, type FiredEvent, type ScheduledEventCommon } from "../src/events.js";

interface TestEvent extends ScheduledEventCommon {
	chatId: number;
}

let eventsDir: string;
let watcher: EventsWatcher<TestEvent>;
let dispatched: FiredEvent<TestEvent>[];
let warnings: string[];
let startTime: number;

beforeEach(() => {
	eventsDir = mkdtempSync(join(tmpdir(), "pi-bot-events-"));
	dispatched = [];
	warnings = [];
	watcher = new EventsWatcher<TestEvent>(
		eventsDir,
		async (event) => {
			dispatched.push(event);
		},
		{
			parse: (content) => JSON.parse(content) as TestEvent,
			queueKey: (event) => event.chatId,
			log: {
				info: () => {},
				warn: (msg, detail) => warnings.push(detail ? `${msg}: ${detail}` : msg),
			},
		},
	);
	// Use the watcher's reference time to create exact filesystem cutoff fixtures.
	startTime = Reflect.get(watcher, "startTime") as number;
});

afterEach(() => {
	watcher.stop();
	rmSync(eventsDir, { recursive: true, force: true });
});

function writeImmediate(mtime?: number): string {
	const filePath = join(eventsDir, "signal.json");
	writeFileSync(filePath, JSON.stringify({ type: "immediate", chatId: 123, text: "New issue" }));
	if (mtime !== undefined) {
		const time = new Date(mtime);
		utimesSync(filePath, time, time);
	}
	return filePath;
}

async function waitForDeletion(filePath: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (existsSync(filePath) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(existsSync(filePath)).toBe(false);
}

describe("EventsWatcher immediate startup tolerance", () => {
	for (const { name, ageMs, shouldDispatch } of [
		{ name: "dispatches an event from two minutes before startup", ageMs: 120_000, shouldDispatch: true },
		{ name: "dispatches an event just inside the five-minute cutoff", ageMs: 299_000, shouldDispatch: true },
		{ name: "dispatches an event exactly at the five-minute cutoff", ageMs: 300_000, shouldDispatch: true },
		{ name: "discards an event just outside the five-minute cutoff", ageMs: 301_000, shouldDispatch: false },
		{ name: "discards an event from 30 minutes before startup", ageMs: 1_800_000, shouldDispatch: false },
	]) {
		test(name, async () => {
			const filePath = writeImmediate(startTime - ageMs);
			watcher.start();
			await waitForDeletion(filePath);

			expect(dispatched).toEqual(
				shouldDispatch
					? [{ type: "immediate", chatId: 123, name: "signal.json", text: "[EVENT:signal.json:immediate:immediate] New issue" }]
					: [],
			);
			expect(warnings).toEqual([]);
		});
	}

	test("dispatches an event written after startup", async () => {
		watcher.start();
		const filePath = writeImmediate();
		await waitForDeletion(filePath);

		expect(dispatched).toEqual([
			{ type: "immediate", chatId: 123, name: "signal.json", text: "[EVENT:signal.json:immediate:immediate] New issue" },
		]);
		expect(warnings).toEqual([]);
	});
});
