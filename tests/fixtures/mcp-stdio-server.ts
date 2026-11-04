#!/usr/bin/env bun
/**
 * Minimal stdio MCP server for exercising the real SDK stdio transport.
 *
 * Environment switches:
 * - MCP_TEST_LIFECYCLE_PATH: append `started:<pid>:<cwd>` and `stopped:<pid>` lines.
 * - MCP_TEST_HANG_INITIALIZE=1: never answer `initialize`, to test cleanup while connecting.
 * - MCP_TEST_REPORT_CONTEXT=1: answer tool calls with the process cwd, args, and MCP_TEST_* values.
 * - MCP_TEST_LOG_MESSAGE: send this text as an MCP log notification before answering a tool call.
 */
import { appendFileSync } from "fs";

const lifecyclePath = process.env.MCP_TEST_LIFECYCLE_PATH;
if (lifecyclePath) appendFileSync(lifecyclePath, `started:${process.pid}:${process.cwd()}\n`);

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: string | number, value: unknown): void {
	send({ jsonrpc: "2.0", id, result: value });
}

function error(id: string | number, code: number, message: string): void {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message: Record<string, unknown>): void {
	const id = message.id;
	const method = message.method;
	if ((typeof id !== "string" && typeof id !== "number") || typeof method !== "string") return;

	switch (method) {
		case "initialize":
			if (process.env.MCP_TEST_HANG_INITIALIZE === "1") return;
			result(id, {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {}, ...(process.env.MCP_TEST_LOG_MESSAGE ? { logging: {} } : {}) },
				serverInfo: { name: "pi-bot-core-test", version: "1.0.0" },
			});
			return;
		case "tools/list":
			result(id, {
				tools: [{
					name: "echo_host",
					description: "Echo a marker from the host MCP process",
					inputSchema: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
						additionalProperties: false,
					},
				}],
			});
			return;
		case "tools/call": {
			const params = message.params as { name?: unknown; arguments?: { text?: unknown } } | undefined;
			if (params?.name !== "echo_host") {
				error(id, -32601, "Unknown tool");
				return;
			}
			if (process.env.MCP_TEST_LOG_MESSAGE) {
				send({
					jsonrpc: "2.0",
					method: "notifications/message",
					params: { level: "info", logger: "fixture", data: process.env.MCP_TEST_LOG_MESSAGE },
				});
			}
			const context = process.env.MCP_TEST_REPORT_CONTEXT === "1" ? {
				cwd: process.cwd(),
				args: process.argv.slice(2),
				expanded: process.env.MCP_TEST_EXPANDED,
				command: process.env.MCP_TEST_COMMAND,
				escaped: process.env.MCP_TEST_ESCAPED,
				literal: process.env.MCP_TEST_LITERAL,
			} : undefined;
			result(id, {
				content: [{
					type: "text",
					text: context ? JSON.stringify(context) : `HOST_MCP:${String(params.arguments?.text ?? "")}`,
				}],
			});
			return;
		}
		case "resources/list":
			result(id, { resources: [] });
			return;
		case "resources/templates/list":
			result(id, { resourceTemplates: [] });
			return;
		case "ping":
			result(id, {});
			return;
		default:
			error(id, -32601, `Method not found: ${method}`);
	}
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline === -1) break;
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		handle(JSON.parse(line) as Record<string, unknown>);
	}
}

if (lifecyclePath) appendFileSync(lifecyclePath, `stopped:${process.pid}\n`);
