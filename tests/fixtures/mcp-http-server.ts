/**
 * Minimal streamable HTTP MCP server for exercising the real SDK HTTP transport.
 *
 * Records every request and the last `Authorization` / `X-Command-Value` headers. `expireSession()`
 * makes the next session-bound request fail with 404 and holds the client's reconnect `initialize`
 * until `resumeInitialization()`, so tests can act while a reconnect is in flight.
 */
type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: { name?: unknown; arguments?: { text?: unknown } };
};

const SESSION_ID = "pi-bot-core-http-test";

export function startMcpHttpServer() {
	let authorization: string | null = null;
	let commandHeader: string | null = null;
	let sessionExpired = false;
	const requests: Array<{ method: string; rpcMethod?: string }> = [];
	const reconnectStarted = Promise.withResolvers<void>();
	const resumeInitialization = Promise.withResolvers<void>();
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			authorization = request.headers.get("authorization");
			commandHeader = request.headers.get("x-command-value");
			if (request.method === "GET" || request.method === "DELETE") {
				requests.push({ method: request.method });
				return new Response(null, { status: request.method === "DELETE" ? 204 : 405 });
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });

			const message = await request.json() as JsonRpcRequest;
			requests.push({ method: request.method, rpcMethod: message.method });
			if (message.id === undefined || message.method === undefined) {
				return new Response(null, { status: 202 });
			}
			let result: unknown;
			switch (message.method) {
				case "initialize":
					if (sessionExpired) {
						reconnectStarted.resolve();
						await resumeInitialization.promise;
						sessionExpired = false;
					}
					result = {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "pi-bot-core-http-test", version: "1.0.0" },
					};
					break;
				case "tools/list":
					result = {
						tools: [{
							name: "echo_http",
							description: "Echo a marker from an HTTP MCP server",
							inputSchema: {
								type: "object",
								properties: { text: { type: "string" } },
								required: ["text"],
								additionalProperties: false,
							},
						}],
					};
					break;
				case "tools/call":
					if (sessionExpired) return new Response("MCP session expired", { status: 404 });
					result = {
						content: [{
							type: "text",
							text: `HTTP_MCP:${String(message.params?.arguments?.text ?? "")}`,
						}],
					};
					break;
				case "resources/list":
					result = { resources: [] };
					break;
				case "resources/templates/list":
					result = { resourceTemplates: [] };
					break;
				case "ping":
					result = {};
					break;
				default:
					return Response.json({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: `Method not found: ${message.method}` },
					});
			}
			return Response.json({ jsonrpc: "2.0", id: message.id, result }, {
				headers: { "mcp-session-id": SESSION_ID },
			});
		},
	});

	return {
		url: new URL("mcp", server.url).href,
		requests,
		get authorization() {
			return authorization;
		},
		get commandHeader() {
			return commandHeader;
		},
		/** Expire the session; resolves when the client starts reconnecting. */
		expireSession() {
			sessionExpired = true;
			return reconnectStarted.promise;
		},
		resumeInitialization: () => resumeInitialization.resolve(),
		stop() {
			resumeInitialization.resolve();
			server.stop(true);
		},
	};
}
