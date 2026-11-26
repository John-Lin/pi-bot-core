import { describe, expect, test } from "bun:test";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createGrepTool } from "@earendil-works/pi-coding-agent";
import { obj, str } from "@earendil-works/pi-schema";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotTools, createChatHistoryTool } from "../src/index.js";
import { HostExecutor } from "./helpers/host-executor.js";

test("the default tools list accepts another SDK tool", () => {
	const tools = createBotTools(new HostExecutor());
	const chatHistory = createChatHistoryTool({ logFilePath: "log.jsonl" });
	tools.push(chatHistory);
	expect(tools.at(-1)).toBe(chatHistory);
});

test("the default tools list also accepts SDK built-ins and inline typed tools", () => {
	const tools = createBotTools(new HostExecutor());
	tools.push(createGrepTool(process.cwd()));
	tools.push({
		name: "reply",
		label: "Reply",
		description: "Send a response",
		parameters: obj({ text: str() }),
		execute: async (_id, { text }: { text: string }) => ({ content: [{ type: "text", text }], details: undefined }),
	});
	expect(tools.slice(-2).map((tool) => tool.name)).toEqual(["grep", "reply"]);
});

describe("workspace tools in the Pi agent pipeline", () => {
	test("returns real tool results with SDK-recorded execution durations", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-bot-core-agent-tools-"));
		const path = join(workspace, "marker.txt");
		const faux = createFauxCore({ provider: "core-test" });
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("write", { label: "Write marker", path, content: "original marker\n" }),
				fauxToolCall("edit", { label: "Edit marker", path, oldText: "original", newText: "edited" }),
				fauxToolCall("read", { label: "Read marker", path }),
				fauxToolCall("bash", { label: "Run command", command: "printf CORE_SDK_TOOL_RESULT" }),
				fauxToolCall("bash", { label: "Fail command", command: "printf CORE_SDK_TOOL_ERROR; exit 1" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const agent = new Agent({
			initialState: {
				model: faux.getModel(),
				tools: createBotTools(new HostExecutor()),
			},
			streamFn: faux.streamSimple,
			toolExecution: "sequential",
		});
		const completions: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "tool_execution_end") completions.push(event);
		});
		try {
			await agent.prompt("Write, edit, and read the marker, then run both commands.");

			expect(readFileSync(path, "utf8")).toBe("edited marker\n");
			expect(completions.map((event) => event.toolName)).toEqual(["write", "edit", "read", "bash", "bash"]);
			expect(completions.map((event) => event.isError)).toEqual([false, false, false, false, true]);
			expect(completions[2]!.result.content).toEqual([{ type: "text", text: "edited marker\n" }]);
			expect(completions[3]!.result.content).toEqual([{ type: "text", text: "CORE_SDK_TOOL_RESULT" }]);
			expect(completions[4]!.result.content).toEqual([{
				type: "text",
				text: "CORE_SDK_TOOL_ERROR\n\nCommand exited with code 1",
			}]);
			for (const event of completions) {
				expect(event.durationMs).toBeNumber();
				expect(event.durationMs).toBeGreaterThanOrEqual(0);
			}
		} finally {
			unsubscribe();
			agent.abort();
			await agent.waitForIdle();
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
