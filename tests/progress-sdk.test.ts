import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "fs";
import { join } from "path";
import { ProgressTracker, type ProgressEvent } from "pi-bot-core/progress";
import { createBotTools, HostExecutor } from "../src/index.js";
import { createBotSession, isolateEnvironment, outputText, runCodemode } from "./helpers/bot-session.js";

type ToolEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_end" }>;

// This is bot-owned projection, not a core SDK dependency. Never forward args or results.
function normalize(event: ToolEvent): ProgressEvent {
	const identity = {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		parentToolCallId: event.parentToolCallId,
	};
	if (event.type === "tool_execution_start") {
		const args = event.args as Record<string, unknown>;
		return { type: "tool_start", ...identity, label: typeof args.label === "string" ? args.label : undefined };
	}
	return { type: "tool_end", ...identity, isError: event.isError, durationMs: event.durationMs };
}

describe("progress with the installed SDK nested tool pipeline", () => {
	test("preserves actual parent IDs and execute durations, including calls rejected before execution", async () => {
		const env = isolateEnvironment("pi-bot-core-progress-");
		try {
			const bot = await createBotSession(env, { tools: createBotTools(new HostExecutor()) });
			try {
				const tracker = new ProgressTracker();
				const events: ToolEvent[] = [];
				const marker = join(env.cwd, "marker.txt");
				writeFileSync(marker, "PRIVATE_TOOL_OUTPUT");
				const unsubscribe = bot.session.subscribe((event) => {
					if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
					events.push(event);
					tracker.apply(normalize(event));
				});
				try {
					// The existing fixture drives real tools with a synthetic assistant tool call, not a model.
					// It emits real nested session events but does not emit the agent-loop wrapper events.
					const outcome = await runCodemode(bot.session, `
				const marker = await tools.read({ label: "Inspect marker", path: ${JSON.stringify(marker)} });
				try { await tools.read({ label: "Missing marker", path: ${JSON.stringify(join(env.cwd, "missing.txt"))} }); } catch {}
				try { await tools.read({ label: "Rejected" }); } catch {}
				return marker;
			`);
					expect(outcome.isError, outputText(outcome)).toBe(false);
					expect(outputText(outcome)).toContain("PRIVATE_TOOL_OUTPUT");
					expect(events.map((event) => event.type)).toEqual([
						"tool_execution_start", "tool_execution_end", "tool_execution_start",
						"tool_execution_end", "tool_execution_start", "tool_execution_end",
					]);
					const assistant = bot.session.agent.state.messages.find((message) => message.role === "assistant");
					if (assistant?.role !== "assistant") throw new Error("Missing synthetic assistant tool input");
					const wrapper = assistant.content.find((part) => part.type === "toolCall");
					if (wrapper?.type !== "toolCall") throw new Error("Missing Codemode tool input");
					expect(wrapper.name).toBe("codemode");
					for (const event of events) {
						expect(event.parentToolCallId).toBe(wrapper.id);
						expect(event.toolName).toBe("read");
					}
					const ends = events.filter((event) => event.type === "tool_execution_end");
					expect(ends.map((event) => event.isError)).toEqual([false, true, true]);
					for (const event of ends.slice(0, 2)) {
						expect(event.durationMs).toBeNumber();
						expect(event.durationMs).toBeGreaterThanOrEqual(0);
					}
					expect(ends[2]!.durationMs).toBeUndefined();
					// Introduce only the actual wrapper from the fixture input, never infer it from an ID prefix.
					tracker.apply({ type: "tool_start", toolCallId: wrapper.id, toolName: wrapper.name });
					const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
					expect(tracker.render()).toBe(`codemode\n  ✓ read — Inspect marker ${duration(ends[0]!.durationMs!)}\n  ✗ read — Missing marker ${duration(ends[1]!.durationMs!)}\n  ✗ read — Rejected`);
					expect(bot.notifications).toEqual([]);
					expect(bot.extensionErrors).toEqual([]);
				} finally {
					unsubscribe();
				}
			} finally {
				await bot.shutdown();
			}
		} finally {
			env.restore();
		}
	});
});
