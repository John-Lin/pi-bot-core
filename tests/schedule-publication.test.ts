import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { lit, obj, opt, str } from "@earendil-works/pi-schema";
import { createScheduleTool } from "../src/tools/schedule.js";

function scheduleTool(workspace: string) {
	return createScheduleTool({
		workspace,
		parameters: obj({ label: str(), type: lit("immediate"), text: str(), name: opt(str()) }),
		description: "Schedule an immediate event",
		buildRouting: () => ({ chatId: 123 }),
	});
}

describe("schedule_event publication", () => {
	test("publishes a complete event without temporary files", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-bot-event-publication-"));
		try {
			const result = await scheduleTool(workspace).execute("schedule", { label: "x", type: "immediate", text: "hi" });
			expect(readdirSync(join(workspace, "events"))).toEqual([result.details.filename]);
			expect(JSON.parse(readFileSync(result.details.path, "utf8"))).toEqual({ type: "immediate", chatId: 123, text: "hi" });
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	test("honors a caller-supplied SDK schema without a label", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-bot-event-no-label-"));
		try {
			const tool = createScheduleTool({
				workspace,
				parameters: obj({ type: lit("immediate"), text: str() }),
				description: "Schedule an immediate event",
				buildRouting: () => ({ chatId: 123 }),
			});
			const result = await tool.execute("schedule", { type: "immediate", text: "hi" });
			expect(JSON.parse(readFileSync(result.details.path, "utf8"))).toEqual({ type: "immediate", chatId: 123, text: "hi" });
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	// Darwin's 1024-byte path limit exposes temp names appended to a valid final path.
	(process.platform === "darwin" ? test : test.skip)("publishes an event near the filesystem path limit", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-bot-event-long-path-")));
		try {
			let workspace = root;
			while (workspace.length < 949) {
				workspace = join(workspace, "d".repeat(Math.min(100, 950 - workspace.length - 1)));
			}
			const eventsDir = join(workspace, "events");
			mkdirSync(eventsDir, { recursive: true });
			const name = "a".repeat(40);
			// Prove a final filename of this length is accepted by the real filesystem.
			const probe = join(eventsDir, `${name}-0000000000000.json`);
			writeFileSync(probe, "probe");
			rmSync(probe);
			const result = await scheduleTool(workspace).execute("schedule", { label: "x", type: "immediate", text: "hi", name });
			expect(JSON.parse(readFileSync(result.details.path, "utf8"))).toEqual({ type: "immediate", chatId: 123, text: "hi" });
			expect(readdirSync(eventsDir)).toEqual([result.details.filename]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
