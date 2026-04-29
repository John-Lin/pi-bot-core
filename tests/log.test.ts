import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger } from "../src/log.js";

interface TestCtx {
	id: string;
	user?: string;
}

const formatContext = (ctx: TestCtx) => `[${ctx.id}:${ctx.user ?? "?"}]`;

let output: string[];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	output = [];
	logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		output.push(args.map((a) => String(a)).join(" "));
	});
});

afterEach(() => {
	logSpy.mockRestore();
});

// Strip ANSI colour codes so assertions test content, not formatting.
function strip(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function line(i = 0): string {
	return strip(output[i] ?? "");
}

describe("createLogger", () => {
	test("uses formatContext for every line tagged with a context", () => {
		const log = createLogger<TestCtx>({ formatContext });
		log.logUserMessage({ id: "C1", user: "alice" }, "hi");
		expect(line()).toMatch(/\[\d{2}:\d{2}:\d{2}\] \[C1:alice\] hi/);
	});

	test("logInfo / logWarning use [system] prefix and ignore formatContext", () => {
		const log = createLogger<TestCtx>({ formatContext });
		log.logInfo("booting");
		log.logWarning("stray event");
		expect(line(0)).toContain("[system]");
		expect(line(0)).toContain("booting");
		expect(line(1)).toContain("[system]");
		expect(line(1)).toMatch(/⚠ stray event/);
	});

	test("logWarning with details emits two lines, without details emits one", () => {
		const log = createLogger<TestCtx>({ formatContext });
		log.logWarning("warn", "more");
		expect(output.length).toBe(2);
		output = [];
		log.logWarning("warn");
		expect(output.length).toBe(1);
	});

	test("logAgentError accepts 'system' or a context", () => {
		const log = createLogger<TestCtx>({ formatContext });
		log.logAgentError("system", "boom");
		expect(line(0)).toContain("[system]");
		output = [];
		log.logAgentError({ id: "C", user: "u" }, "boom");
		expect(line(0)).toContain("[C:u]");
	});

	test("attachment download lifecycle logs format filename, size, error", () => {
		const log = createLogger<TestCtx>({ formatContext });
		const ctx: TestCtx = { id: "C", user: "u" };
		log.logDownloadStart(ctx, "p.jpg", "C/attachments/p.jpg");
		expect(line(0)).toMatch(/↓ Downloading attachment/);
		expect(line(1)).toContain("p.jpg");
		expect(line(1)).toContain("C/attachments/p.jpg");
		output = [];

		log.logDownloadSuccess(ctx, 42);
		expect(line()).toMatch(/✓ Downloaded \(42 KB\)/);
		output = [];

		log.logDownloadError(ctx, "p.jpg", "HTTP 404");
		expect(line(0)).toMatch(/✗ Download failed/);
		expect(line(1)).toContain("p.jpg");
		expect(line(1)).toContain("HTTP 404");
	});

	test("logToolStart formats path:offset-end when both are given", () => {
		const log = createLogger<TestCtx>({ formatContext });
		const ctx: TestCtx = { id: "C", user: "u" };
		log.logToolStart(ctx, "read", "read foo", { path: "/x/foo", offset: 10, limit: 5 });
		expect(line(0)).toMatch(/↳ read: read foo/);
		// Indented detail line should contain "/x/foo:10-15"
		expect(line(1)).toContain("/x/foo:10-15");
	});

	test("logToolStart drops 'label' from detail body", () => {
		const log = createLogger<TestCtx>({ formatContext });
		log.logToolStart({ id: "C" }, "bash", "run sh", { label: "run sh", command: "ls" });
		expect(line(1)).not.toContain("run sh\n"); // label not duplicated in body
		expect(line(1)).toContain("ls");
	});

	test("logResponseStart embeds TTFT when provided", () => {
		const log = createLogger<TestCtx>({ formatContext });
		log.logResponseStart({ id: "C" }, 1234);
		expect(line()).toMatch(/Streaming response\.\.\. \(TTFT 1\.2s\)/);
		output = [];
		log.logResponseStart({ id: "C" });
		expect(line()).toMatch(/Streaming response\.\.\.$/);
	});

	test("logUsageSummary returns a markdown summary using the configured bold formatter", () => {
		const log = createLogger<TestCtx>({
			formatContext,
			formatBold: (text) => `<b>${text}</b>`,
		});
		const summary = log.logUsageSummary(
			{ id: "C", user: "u" },
			{
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
		);
		expect(summary).toContain("<b>Usage Summary</b>");
		expect(summary).toContain("<b>Total: $0.0030</b>");
		expect(summary).toContain("100 in");
		expect(summary).toContain("50 out");
	});

	test("logUsageSummary defaults to ** bold marker when formatBold is omitted", () => {
		const log = createLogger<TestCtx>({ formatContext });
		const summary = log.logUsageSummary(
			{ id: "C" },
			{
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		);
		expect(summary).toContain("**Usage Summary**");
		expect(summary).toContain("**Total: $0.0000**");
	});

	test("logUsageSummary includes cache + context window lines only when relevant", () => {
		const log = createLogger<TestCtx>({ formatContext });
		const summary = log.logUsageSummary(
			{ id: "C" },
			{
				input: 100,
				output: 50,
				cacheRead: 25,
				cacheWrite: 10,
				cost: {
					input: 0.001,
					output: 0.002,
					cacheRead: 0.0001,
					cacheWrite: 0.0002,
					total: 0.0033,
				},
			},
			5000,
			200_000,
		);
		expect(summary).toContain("Cache: 25 read, 10 write");
		expect(summary).toContain("Context: 5.0k / 200k (2.5%)");
		expect(summary).toContain("cache read");
	});

	test("every context-tagged line starts with [HH:MM:SS]", () => {
		const log = createLogger<TestCtx>({ formatContext });
		log.logInfo("hello");
		expect(line()).toMatch(/^\[\d{2}:\d{2}:\d{2}\] /);
	});
});
