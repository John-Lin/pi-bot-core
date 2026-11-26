import { expect, expectTypeOf, test } from "bun:test";
import type { TruncationResult as SdkTruncationResult } from "@earendil-works/pi-coding-agent";
import { type BashToolDetails, type ReadToolDetails, type TruncationResult } from "pi-bot-core/tools";
import { truncateTail } from "../src/tools/truncate.js";

test("the published tool details accept truncation results from the SDK", () => {
	expectTypeOf<SdkTruncationResult>().toExtend<NonNullable<BashToolDetails["truncation"]>>();
	expectTypeOf<SdkTruncationResult>().toExtend<NonNullable<ReadToolDetails["truncation"]>>();
	expectTypeOf<ReturnType<typeof truncateTail>>().toEqualTypeOf<TruncationResult>();
});

test("reports byte truncation for a partial line even at the line limit", () => {
	const result = truncateTail("first\nlast line", { maxLines: 1, maxBytes: 4 });
	expect(result).toMatchObject({
		content: "line",
		truncated: true,
		truncatedBy: "bytes",
		lastLinePartial: true,
		firstLineExceedsLimit: false,
	});
});

test("untruncated output has no limit or partial line", () => {
	expect(truncateTail("short output")).toMatchObject({
		truncated: false, truncatedBy: null, lastLinePartial: false, firstLineExceedsLimit: false,
	});
});
