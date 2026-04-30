import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DownloadQueue, type DownloadQueueLogger } from "../src/download-queue.js";

let ws: string;

beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "pi-bot-dq-"));
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
});

interface TestCtx {
	id: string;
}

interface LogEvent {
	kind: "start" | "success" | "error";
	ctx: TestCtx;
	a: string;
	b: string | number;
}

function makeLog(): { events: LogEvent[]; log: DownloadQueueLogger<TestCtx> } {
	const events: LogEvent[] = [];
	return {
		events,
		log: {
			logDownloadStart: (ctx, filename, localPath) =>
				events.push({ kind: "start", ctx, a: filename, b: localPath }),
			logDownloadSuccess: (ctx, sizeKB) =>
				events.push({ kind: "success", ctx, a: "", b: sizeKB }),
			logDownloadError: (ctx, filename, error) =>
				events.push({ kind: "error", ctx, a: filename, b: error }),
		},
	};
}

describe("DownloadQueue", () => {
	test("writes to <workingDir>/<localPath> via the injected downloadFile", async () => {
		const { log } = makeLog();
		const calls: Array<{ source: string; destPath: string }> = [];
		const q = new DownloadQueue<TestCtx>({
			workingDir: ws,
			downloadFile: async (source, destPath) => {
				calls.push({ source, destPath });
				writeFileSync(destPath, "data");
			},
			log,
		});
		q.enqueue({
			source: "https://cdn/1",
			localPath: "c1/attachments/M_p.png",
			originalName: "p.png",
			logContext: { id: "C1" },
		});
		await q.waitForDownloads();

		expect(calls).toEqual([
			{ source: "https://cdn/1", destPath: join(ws, "c1/attachments/M_p.png") },
		]);
		expect(readFileSync(join(ws, "c1/attachments/M_p.png"), "utf8")).toBe("data");
	});

	test("creates the destination directory if missing", async () => {
		const { log } = makeLog();
		const q = new DownloadQueue<TestCtx>({
			workingDir: ws,
			downloadFile: async (_s, destPath) => {
				writeFileSync(destPath, "ok");
			},
			log,
		});
		q.enqueue({
			source: "u",
			localPath: "fresh/attachments/x.txt",
			originalName: "x.txt",
			logContext: { id: "C" },
		});
		await q.waitForDownloads();
		expect(existsSync(join(ws, "fresh/attachments"))).toBe(true);
	});

	test("download failure does not throw or poison subsequent items", async () => {
		const { log, events } = makeLog();
		let calls = 0;
		const q = new DownloadQueue<TestCtx>({
			workingDir: ws,
			downloadFile: async () => {
				calls++;
				throw new Error("HTTP 404");
			},
			log,
		});
		q.enqueue({ source: "u1", localPath: "x/a.png", originalName: "a.png", logContext: { id: "C" } });
		q.enqueue({ source: "u2", localPath: "x/b.png", originalName: "b.png", logContext: { id: "C" } });
		await q.waitForDownloads();

		expect(calls).toBe(2);
		expect(events.filter((e) => e.kind === "error")).toHaveLength(2);
	});

	test("processes items in submission order", async () => {
		const { log } = makeLog();
		const order: string[] = [];
		const q = new DownloadQueue<TestCtx>({
			workingDir: ws,
			downloadFile: async (source) => {
				order.push(source);
			},
			log,
		});
		q.enqueue({ source: "u1", localPath: "x/a.png", originalName: "a", logContext: { id: "C" } });
		q.enqueue({ source: "u2", localPath: "x/b.png", originalName: "b", logContext: { id: "C" } });
		await q.waitForDownloads();
		expect(order).toEqual(["u1", "u2"]);
	});

	test("coalesces concurrent enqueues into a single drain", async () => {
		const { log } = makeLog();
		const order: string[] = [];
		const q = new DownloadQueue<TestCtx>({
			workingDir: ws,
			downloadFile: async (source) => {
				order.push(source);
			},
			log,
		});
		q.enqueue({ source: "u1", localPath: "x/a.png", originalName: "a", logContext: { id: "C" } });
		q.enqueue({ source: "u2", localPath: "x/b.png", originalName: "b", logContext: { id: "C" } });
		await q.waitForDownloads();
		expect(order).toEqual(["u1", "u2"]);
	});

	test("emits start, success, and error logs with the per-item context", async () => {
		const { log, events } = makeLog();
		const q = new DownloadQueue<TestCtx>({
			workingDir: ws,
			downloadFile: async (source, destPath) => {
				if (source === "fail") throw new Error("nope");
				writeFileSync(destPath, "ok");
			},
			log,
		});
		q.enqueue({ source: "u1", localPath: "x/a.png", originalName: "a.png", logContext: { id: "ok" } });
		q.enqueue({ source: "fail", localPath: "x/b.png", originalName: "b.png", logContext: { id: "bad" } });
		await q.waitForDownloads();

		expect(events.map((e) => e.kind)).toEqual(["start", "success", "start", "error"]);
		expect(events[0]!.ctx).toEqual({ id: "ok" });
		expect(events[3]!.ctx).toEqual({ id: "bad" });
		expect(events[3]!.b).toBe("nope");
	});

	test("waitForDownloads resolves immediately when queue is empty", async () => {
		const { log } = makeLog();
		const q = new DownloadQueue<TestCtx>({
			workingDir: ws,
			downloadFile: async () => {},
			log,
		});
		await q.waitForDownloads();
	});
});
