import { describe, expect, test } from "bun:test";
import { ProgressTracker, type ProgressEvent } from "pi-bot-core/progress";

function start(toolCallId: string, toolName = "bash", label?: string, parentToolCallId?: string): ProgressEvent {
	return { type: "tool_start", toolCallId, toolName, label, parentToolCallId };
}

function end(toolCallId: string, toolName = "bash", isError = false, durationMs?: number): ProgressEvent {
	return { type: "tool_end", toolCallId, toolName, isError, durationMs };
}

function progress(...events: ProgressEvent[]): ProgressTracker {
	const tracker = new ProgressTracker();
	for (const event of events) tracker.apply(event);
	return tracker;
}

describe("ProgressTracker public subpath", () => {
	test("starts empty and keeps run state isolated", () => {
		const first = progress(start("a", "read"));
		const second = new ProgressTracker();
		expect(second.render()).toBe("Working…");
		second.apply(start("a", "write"));
		expect(first.render()).toBe("… read");
		expect(second.render()).toBe("… write");
	});

	test("renders direct running, successful and failed tools without redundant labels", () => {
		expect(progress(
			start("a", "read", " read "),
			start("b", "bash", "Check CI"),
			start("c", "write"),
			end("a", "read"),
			end("b", "bash", true, 34_100),
		).render()).toBe("✓ read\n✗ bash — Check CI 34.1s\n… write");
	});

	test.each([
		[undefined, ""], [0, " 0ms"], [0.4, " 0ms"], [12.6, " 13ms"],
		[999, " 999ms"], [999.6, " 1000ms"], [1000, " 1.0s"], [34_140, " 34.1s"], [44_900, " 44.9s"],
	])("formats SDK duration %s without clocks or concurrent sums", (durationMs, suffix) => {
		expect(progress(start("a"), end("a", "bash", false, durationMs)).render()).toBe(`✓ bash${suffix}`);
	});

	test("keeps same-name/same-label invocations independent, including sequential retries", () => {
		const tracker = progress(start("a", "bash", "Inspect"), start("b", "bash", "Inspect"), end("a", "bash", true));
		expect(tracker.render()).toBe("✗ bash — Inspect\n… bash — Inspect");
		tracker.apply(end("b"));
		tracker.apply(start("c", "bash", "Inspect"));
		expect(tracker.render()).toBe("✗ bash — Inspect\n✓ bash — Inspect\n… bash — Inspect");
	});

	test("duplicate starts and ends are idempotent and the first terminal result wins", () => {
		const tracker = progress(start("a"), start("b"), start("c"), start("d"));
		tracker.apply(start("b", "write", "replacement"));
		tracker.apply(end("a", "bash", true, 0));
		expect(tracker.render()).toBe("… bash\n… bash\n✗ bash 0ms");
		tracker.apply(end("a", "bash", false, 5000));
		tracker.apply(start("a"));
		tracker.apply(end("unknown", "codemode", true));
		expect(tracker.render()).toBe("… bash\n… bash\n✗ bash 0ms");
	});

	test("selects the latest three revisions, preserving visible order and readmitting hidden completions", () => {
		const tracker = progress(start("a", "read"), start("b", "write"), start("c", "edit"));
		tracker.apply(end("a", "read"));
		expect(tracker.render()).toBe("✓ read\n… write\n… edit");
		tracker.apply(start("d", "bash"));
		expect(tracker.render()).toBe("✓ read\n… edit\n… bash");
		tracker.apply(end("b", "write"));
		expect(tracker.render()).toBe("✓ read\n… bash\n✓ write");
	});

	test("retains compaction and retry notices in the same three-row budget without timestamp collisions", () => {
		const tracker = progress(start("a"), start("b", "read"), { type: "compaction" }, { type: "retry", attempt: 1, max: 3 });
		tracker.apply(end("b", "read"));
		expect(tracker.render()).toBe("✓ read\n… Compacting context\n… Retrying (1/3)");
		tracker.apply({ type: "compaction" });
		tracker.apply({ type: "compaction" });
		expect(tracker.render()).toBe("✓ read\n… Compacting context\n… Compacting context");
	});
});

describe("Codemode progress", () => {
	test("renders the approved three-child example with a heading outside the row budget", () => {
		const tracker = progress(
			start("parent", "codemode", "Do not show wrapper labels"),
			start("telegram", "bash", "Check Telegram CI", "parent"),
			start("discord", "bash", "Check Discord CI", "parent"),
			start("slack", "bash", "Check Slack CI", "parent"),
			end("discord", "bash", false, 34_100),
			end("slack", "bash", false, 44_900),
		);
		expect(tracker.render()).toBe("codemode\n  … bash — Check Telegram CI\n  ✓ bash — Check Discord CI 34.1s\n  ✓ bash — Check Slack CI 44.9s");
	});

	test("uses a generic script row before the first child and for pure JavaScript success", () => {
		const tracker = progress(start("parent", "codemode", "return SECRET"));
		expect(tracker.render()).toBe("codemode\n  … Script");
		tracker.apply(end("parent", "codemode", false, 0));
		expect(tracker.render()).toBe("codemode\n  ✓ Script 0ms");
	});

	test("replaces the script placeholder with real children and does not refresh them on parent success", () => {
		const tracker = progress(start("p", "codemode"), start("a", "read", undefined, "p"), end("a", "read", false, 12));
		expect(tracker.render()).toBe("codemode\n  ✓ read 12ms");
		tracker.apply(end("p", "codemode", false, 99));
		expect(tracker.render()).toBe("codemode\n  ✓ read 12ms");
		tracker.apply(start("b", "write"));
		tracker.apply(start("c", "edit"));
		tracker.apply(start("d", "bash"));
		expect(tracker.render()).toBe("… write\n… edit\n… bash");
	});

	test.each([false, true])("makes parent failure explicit with successful children: %s", (withChild) => {
		const tracker = progress(start("p", "codemode"));
		if (withChild) {
			tracker.apply(start("a", "read", undefined, "p"));
			tracker.apply(end("a", "read", false, 1));
		}
		tracker.apply(end("p", "codemode", true, 20));
		const expected = `codemode\n${withChild ? "  ✓ read 1ms\n" : ""}  ✗ Script failed 20ms`;
		expect(tracker.render()).toBe(expected);
		tracker.apply(end("p", "codemode", false, 100));
		tracker.apply(start("p", "codemode"));
		expect(tracker.render()).toBe(expected);
	});

	test("retains parent failure when children start or finish late, within the ordinary row budget", () => {
		const tracker = progress(start("p", "codemode"), end("p", "codemode", true), start("a", "bash", "late", "p"));
		tracker.apply(end("a", "bash", false, 8));
		expect(tracker.render()).toBe("codemode\n  ✗ Script failed\n  ✓ bash — late 8ms");
	});

	test("keeps a child failure after parent success", () => {
		expect(progress(start("p", "codemode"), start("a", "bash", undefined, "p"), end("a", "bash", true), end("p", "codemode")).render())
			.toBe("codemode\n  ✗ bash");
	});

	test("distinguishes concurrent parents by ID, not by the identical heading or child label", () => {
		const tracker = progress(
			start("p1", "codemode"), start("p2", "codemode"),
			start("a", "bash", "Inspect", "p1"), start("b", "bash", "Inspect", "p2"),
			start("c", "read", undefined, "p1"), end("b", "bash", true),
		);
		expect(tracker.render()).toBe("codemode\n  … bash — Inspect\ncodemode\n  ✗ bash — Inspect\ncodemode\n  … read");
	});

	test("follows known parent chains through native tools and nested Codemode without reordering rows", () => {
		expect(progress(
			start("p", "codemode"), start("a", "bash", undefined, "p"),
			start("b", "read", undefined, "a"), start("nested", "codemode", undefined, "p"),
			start("c", "write", undefined, "nested"),
		).render()).toBe("codemode\n  … bash\n  … read\n  codemode\n    … write");
	});

	test("does not invent a Codemode parent for unknown parents, matching labels or ID prefixes", () => {
		expect(progress(
			start("p", "codemode"), start("p/1", "read"),
			start("other", "bash", "codemode", "unknown"),
		).render()).toBe("codemode\n  … Script\n… read\n… bash — codemode");
	});

	test("associates a visible child when its actual parent arrives later", () => {
		const tracker = progress(start("a", "read", undefined, "p"));
		expect(tracker.render()).toBe("… read");
		tracker.apply(start("p", "codemode"));
		expect(tracker.render()).toBe("codemode\n  … read");
	});

	test("hides headings without visible rows and restores the right heading for a late completion", () => {
		const tracker = progress(start("p", "codemode"), start("a", "read", undefined, "p"), start("b"), start("c"), start("d"));
		expect(tracker.render()).toBe("… bash\n… bash\n… bash");
		tracker.apply(end("p", "codemode"));
		tracker.apply(end("a", "read", true, 4));
		expect(tracker.render()).toBe("… bash\n… bash\ncodemode\n  ✗ read 4ms");
	});

	test("counts script failure and notices as status rows, not headings", () => {
		expect(progress(
			start("p", "codemode"), start("a", "read", undefined, "p"), start("b", "write", undefined, "p"),
			end("a", "read"), end("b", "write"), end("p", "codemode", true), { type: "compaction" },
		).render()).toBe("codemode\n  ✓ write\n  ✗ Script failed\n… Compacting context");
	});
});

describe("progress text boundaries", () => {
	test("normalizes tool names and labels, removes control characters and omits empty labels", () => {
		expect(progress(start("a", "  mcp__host\n__read\u0000 ", "  Inspect\n\t workspace  ")).render())
			.toBe("… mcp__host __read — Inspect workspace");
		expect(progress(start("a", "read", " \n\t ")).render()).toBe("… read");
	});

	test("bounds the combined name/separator/label to 120 Unicode code points", () => {
		const tracker = progress(start("a", "bash", "😀".repeat(140)), start("b", "bash", "😀".repeat(140) + "other"));
		const title = `bash — ${"😀".repeat(112)}…`;
		expect(Array.from(title)).toHaveLength(120);
		expect(tracker.render()).toBe(`… ${title}\n… ${title}`);
		tracker.apply(end("a"));
		expect(tracker.render()).toBe(`✓ ${title}\n… ${title}`);
	});

	test("preserves exact budgets and bounds long tool names without dangling separators", () => {
		expect(progress(start("a", "😀".repeat(120))).render()).toBe(`… ${"😀".repeat(120)}`);
		expect(progress(start("a", "😀".repeat(121), "label")).render()).toBe(`… ${"😀".repeat(119)}…`);
		expect(progress(start("a", "n".repeat(117), "label")).render()).toBe(`… ${"n".repeat(117)}`);
	});

	test("composes platform escaping for both names and labels after truncation without changing state", () => {
		const tracker = progress(start("p", "codemode"), start("a", "mcp__host__read", "Inspect *CI*", "p"));
		const escapeMarkdown = (text: string) => text.replace(/([_*])/g, "\\$1");
		expect(tracker.render(escapeMarkdown)).toBe("codemode\n  … mcp\\_\\_host\\_\\_read — Inspect \\*CI\\*");
		expect(tracker.render()).toBe("codemode\n  … mcp__host__read — Inspect *CI*");
		const long = progress(start("b", "read", "_".repeat(140)));
		expect(long.render(escapeMarkdown)).toBe(`… read — ${"\\_".repeat(112)}…`);
	});

	test("never renders wrapper code, arguments, results, errors, stacks or unrelated event fields", () => {
		const tracker = new ProgressTracker();
		const unsafeStart = { ...start("p", "codemode", "SECRET_LABEL"), args: { code: "SECRET_CODE" } };
		const unsafeEnd = { ...end("p", "codemode", true), result: "SECRET_RESULT", error: "SECRET_STACK" };
		tracker.apply(unsafeStart);
		tracker.apply(unsafeEnd);
		expect(tracker.render()).toBe("codemode\n  ✗ Script failed");
	});
});

describe("progress history cleanup", () => {
	test("bounds completed payloads while pinning ancestor metadata for hidden active children", () => {
		const tracker = progress(start("p", "codemode"), start("bridge", "read", undefined, "p"), start("child", "bash", "Inspect", "bridge"), end("bridge", "read"), end("p", "codemode"));
		for (let i = 0; i < 1000; i++) {
			tracker.apply(start(`completed-${i}`));
			tracker.apply(end(`completed-${i}`));
		}
		// Inspect retained real state: completed payloads must not accumulate behind the UI cap.
		expect(tracker["calls"].size).toBe(6);
		tracker.apply(end("child", "bash", true, 7));
		expect(tracker.render()).toBe("✓ bash\n✓ bash\ncodemode\n  ✗ bash — Inspect 7ms");
		for (let i = 0; i < 3; i++) tracker.apply({ type: "compaction" });
		expect(tracker["calls"].size).toBe(0);
		const before = tracker.render();
		tracker.apply(start("completed-0"));
		tracker.apply(end("completed-0", "bash", true));
		tracker.apply(start("p", "codemode"));
		expect(tracker.render()).toBe(before);
	});
});
