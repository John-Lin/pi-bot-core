import { describe, expect, test } from "bun:test";
import { type Tool, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { compile, lit, num, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import { HostExecutor } from "../src/sandbox.js";
import {
	createAttachTool,
	createBashTool,
	createChatHistoryTool,
	createEditTool,
	createReadTool,
	createScheduleTool,
	createTelegraphEditTool,
	createTelegraphGetTool,
	createTelegraphListTool,
	createTelegraphPublishTool,
	createWriteTool,
} from "../src/tools/index.js";

function validateArgs(tool: Tool, args: ToolCall["arguments"]) {
	return validateToolArguments(tool, { type: "toolCall", id: "schema-test", name: tool.name, arguments: args });
}

const executor = new HostExecutor();
const label = "Validate tool parameters";
const cases: { tool: Tool; args: ToolCall["arguments"]; optional: ToolCall["arguments"] }[] = [
	{ tool: createReadTool(executor), args: { label, path: "/tmp/file" }, optional: { offset: 2, limit: 3 } },
	{ tool: createBashTool(executor), args: { label, command: "pwd" }, optional: { timeout: 5 } },
	{ tool: createEditTool(executor), args: { label, path: "/tmp/file", oldText: "a", newText: "b" }, optional: {} },
	{ tool: createWriteTool(executor), args: { label, path: "/tmp/file", content: "text" }, optional: {} },
	{ tool: createAttachTool().tool, args: { label, path: "/tmp/file" }, optional: { title: "file.txt" } },
	{
		tool: createChatHistoryTool({ logFilePath: "/tmp/log.jsonl" }),
		args: { label },
		optional: { query: "text", after: "2026-01-01", before: "2026-12-31", limit: 20 },
	},
	{
		tool: createTelegraphPublishTool("/tmp", { short_name: "test", author_name: "Test" }),
		args: { label, title: "Title", content: "Body" },
		optional: { author_name: "Author" },
	},
	{ tool: createTelegraphGetTool(), args: { label, url_or_path: "Title-01-01" }, optional: {} },
	{
		tool: createTelegraphEditTool("/tmp"),
		args: { label, url_or_path: "Title-01-01", title: "Title", content: "Body" },
		optional: { author_name: "Author" },
	},
	{ tool: createTelegraphListTool("/tmp"), args: { label }, optional: { offset: 0, limit: 50 } },
];

describe("Pi SDK schema dependency contract", () => {
	test("uses pi-schema directly and requires the schema-aware SDK", () => {
		expect(packageJson.dependencies).not.toHaveProperty("typebox");
		expect(packageJson.dependencies).toHaveProperty("@earendil-works/pi-schema", "^1.5.0");
		for (const version of Object.values(packageJson.peerDependencies)) {
			expect(version).toBe("^1.5.0");
		}
	});
});

describe("tool parameter schemas", () => {
	for (const { tool, args, optional } of cases) {
		test(`${tool.name}: validates required and optional parameters through the SDK`, () => {
			expect(validateArgs(tool, args)).toEqual(args);
			const full = { ...args, ...optional };
			expect(validateArgs(tool, full)).toEqual(full);

			const validator = compile(tool.parameters);
			for (const key of Object.keys(args)) {
				const missing: Record<string, unknown> = { ...args };
				delete missing[key];
				expect(validator.check(missing)).toBe(false);
			}
			expect(validator.check({ ...args, label: [] })).toBe(false);
			expect(validator.check({ ...args, extra: "allowed" })).toBe(true);
			expect(compile(JSON.parse(JSON.stringify(tool.parameters))).check(full)).toBe(true);
		});
	}

	test("preserves numeric coercion, optional nulls, and numeric bounds", () => {
		const read = createReadTool(executor);
		expect(validateArgs(read, { label, path: "/tmp/file", offset: "2", limit: null })).toEqual({
			label, path: "/tmp/file", offset: 2,
		});
		const history = compile(createChatHistoryTool({ logFilePath: "/tmp/log.jsonl" }).parameters);
		expect(history.check({ label, limit: 1 })).toBe(true);
		expect(history.check({ label, limit: 200 })).toBe(true);
		expect(history.check({ label, limit: 0 })).toBe(false);
		expect(history.check({ label, limit: 201 })).toBe(false);
	});

	test("accepts an inferred pi-schema schedule and persists platform routing", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "pi-bot-core-schedule-schema-"));
		const parameters = obj({
			label: str(),
			type: lit("immediate"),
			text: str(),
			chatId: num(),
			threadId: opt(num()),
		});
		const args: Static<typeof parameters> = { label, type: "immediate", text: "Reminder", chatId: 123, threadId: 42 };
		const tool = createScheduleTool({
			workspace,
			parameters,
			description: "Schedule a reminder",
			buildRouting: (args) => {
				const chatId: number = args.chatId;
				const threadId: number | undefined = args.threadId;
				return { chatId, threadId };
			},
		});
		try {
			const validated = validateArgs(tool, args);
			const result = await tool.execute("schedule-test", validated);
			expect(JSON.parse(readFileSync(result.details.path, "utf8"))).toEqual({
				type: "immediate", chatId: 123, threadId: 42, text: "Reminder",
			});
			expect(compile(parameters).check({ label, type: "immediate", text: "Reminder", chatId: 123 })).toBe(true);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
