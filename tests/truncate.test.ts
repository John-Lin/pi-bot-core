import { expect, expectTypeOf, test } from "bun:test";
import { type TruncationResult, truncateTail } from "../src/tools/truncate.js";

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
	type Complete = Extract<TruncationResult, { truncated: false }>;
	expectTypeOf<Complete["truncatedBy"]>().toEqualTypeOf<null>();
	expectTypeOf<Complete["lastLinePartial"]>().toEqualTypeOf<false>();
});
