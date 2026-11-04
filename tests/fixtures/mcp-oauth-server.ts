import { startMcpHttpServer } from "./mcp-http-server.js";

/**
 * Local OAuth protected resource and authorization server for exercising real HTTP token refresh.
 * Records every path it serves so tests can prove no interactive sign-in was attempted.
 */
export function startMcpOAuthServer() {
	const mcp = startMcpHttpServer();
	const authorizations: Array<string | null> = [];
	const refreshRequests: URLSearchParams[] = [];
	const paths: string[] = [];
	let accessToken = "valid-token";
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const origin = url.origin;
			paths.push(url.pathname);
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				return Response.json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					token_endpoint_auth_methods_supported: ["none"],
					code_challenge_methods_supported: ["S256"],
				});
			}
			if (url.pathname === "/token" && request.method === "POST") {
				const params = new URLSearchParams(await request.text());
				refreshRequests.push(params);
				if (params.get("grant_type") !== "refresh_token" || params.get("refresh_token") !== "refresh-token") {
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				}
				accessToken = "refreshed-token";
				return Response.json({
					access_token: accessToken,
					refresh_token: "rotated-refresh-token",
					token_type: "Bearer",
					expires_in: 3600,
				});
			}
			if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
			const authorization = request.headers.get("authorization");
			authorizations.push(authorization);
			if (authorization !== `Bearer ${accessToken}`) {
				return new Response(null, {
					status: 401,
					headers: {
						"WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
					},
				});
			}
			return fetch(mcp.url, {
				method: request.method,
				headers: request.headers,
				body: request.method === "POST" ? await request.text() : undefined,
			});
		},
	});
	return {
		url: new URL("mcp", server.url).href,
		authorizations,
		refreshRequests,
		paths,
		stop() {
			server.stop(true);
			mcp.stop();
		},
	};
}
