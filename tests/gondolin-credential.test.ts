import { expect, test } from "bun:test";
import { createGondolinSecretHooks, normalizeGondolinSecrets } from "../src/gondolin-credential.js";

const interactions = "https://api.example.com/v1/interactions";
const decisions = "https://api.example.com/v1/decisions";
const key = "fixture-host-only-key-not-a-real-credential";
const pat = "fixture-host-only-pat-not-a-real-credential";
const keyConfig = { value: key, hosts: ["API.EXAMPLE.COM"], header: "X-Test-Api-Key" };

function secretHooks(value = key) {
	const hooks = createGondolinSecretHooks(normalizeGondolinSecrets({
		TEST_API_KEY: { ...keyConfig, value },
		GH_TOKEN: { value: pat, hosts: ["api.github.com", "github.com"], header: "authorization" },
	}));
	if (!hooks?.httpHooks.onRequest) throw new Error("Expected a Gondolin request hook");
	return { keyEnv: hooks.env.TEST_API_KEY!, ghEnv: hooks.env.GH_TOKEN!, onRequest: hooks.httpHooks.onRequest };
}

function basic(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function expectDenied(onRequest: ReturnType<typeof secretHooks>["onRequest"], request: Request) {
	const result = await onRequest(request);
	if (!(result instanceof Response)) throw new Error("Expected credential misuse to be blocked locally");
	expect(result.status).toBe(403);
	expect(await result.text()).toBe("The workspace credential is not allowed for this request.");
}

test.each([interactions, decisions])("fills only the configured header on POST %s", async (url) => {
	const { keyEnv, onRequest } = secretHooks();
	const forwarded = await onRequest(new Request(url, {
		method: "POST",
		headers: { host: "api.example.com", "x-test-api-key": keyEnv, "content-type": "application/json" },
		body: JSON.stringify({ label: keyEnv }),
	}));
	if (!(forwarded instanceof Request)) throw new Error("Expected the allowed request to be forwarded");
	expect(forwarded.headers.get("x-test-api-key")).toBe(key);
	expect(forwarded.headers.get("host")).toBeNull();
	expect(await forwarded.json()).toEqual({ label: keyEnv });
});

test("uses the same host policy for other paths and methods without expanding URL parameters", async () => {
	const { keyEnv, onRequest } = secretHooks();
	const url = `https://api.example.com/v1/models?label=${keyEnv}`;
	const forwarded = await onRequest(new Request(url, { headers: { "x-test-api-key": keyEnv } }));
	if (!(forwarded instanceof Request)) throw new Error("Expected the allowed request to be forwarded");
	expect(forwarded.method).toBe("GET");
	expect(forwarded.url).toBe(url);
	expect(forwarded.headers.get("x-test-api-key")).toBe(key);
});

test.each(["token", "Bearer", "Basic"])("forwards the PAT using %s authorization", async (scheme) => {
	const { ghEnv, onRequest } = secretHooks();
	const isBasic = scheme === "Basic";
	const url = isBasic ? "https://github.com/owner/repo.git/info/refs?service=git-receive-pack" : "https://api.github.com/user";
	const forwarded = await onRequest(new Request(url, {
		headers: { authorization: isBasic ? basic("x-access-token", ghEnv) : `${scheme} ${ghEnv}` },
	}));
	if (!(forwarded instanceof Request)) throw new Error("Expected the allowed request to be forwarded");
	expect(forwarded.url).toBe(url);
	expect(forwarded.headers.get("authorization")).toBe(isBasic ? basic("x-access-token", pat) : `${scheme} ${pat}`);
});

test("denies injection on an unapproved host, transport, or header", async () => {
	const { keyEnv, ghEnv, onRequest } = secretHooks();
	const cases = [
		new Request("https://example.com/v1/interactions", { headers: { "x-test-api-key": keyEnv } }),
		new Request("http://api.example.com/v1/interactions", { headers: { "x-test-api-key": keyEnv } }),
		new Request("https://api.example.com:8443/v1/decisions", { headers: { "x-test-api-key": keyEnv } }),
		new Request(interactions, { headers: { "x-other-header": keyEnv } }),
		new Request(interactions, { headers: { connection: keyEnv } }),
		new Request(interactions, { headers: { host: "other.example.com", "x-test-api-key": keyEnv } }),
		new Request(interactions, { headers: { "x-test-api-key": keyEnv, "x-other-header": keyEnv } }),
		new Request(interactions, { headers: { "x-test-api-key": keyEnv, authorization: `token ${ghEnv}` } }),
		new Request("https://example.com/owner/repo.git", { headers: { authorization: basic("git", ghEnv) } }),
		new Request("https://api.github.com/user", { headers: { authorization: basic(ghEnv, "not-the-placeholder") } }),
		new Request("https://api.github.com/user", { headers: { authorization: basic("git", ghEnv), "x-other-header": ghEnv } }),
		new Request("https://api.github.com/user", { headers: { "proxy-authorization": basic("git", ghEnv) } }),
	];
	for (const request of cases) await expectDenied(onRequest, request);
});

test("leaves an unrelated public request unchanged", async () => {
	const { keyEnv, onRequest } = secretHooks();
	const request = new Request(`https://example.com/?label=${keyEnv}`, { headers: { authorization: "Bearer unrelated-fixture" } });
	expect(await onRequest(request)).toBe(request);
	expect(request.headers.get("authorization")).toBe("Bearer unrelated-fixture");
	expect(request.headers.get("x-test-api-key")).toBeNull();
	expect(new URL(request.url).searchParams.get("label")).toBe(keyEnv);
});

test("blocks redirected hops carrying an already injected header", async () => {
	const { onRequest, keyEnv, ghEnv } = secretHooks(` \t${key}\t `);
	const git = "https://github.com/owner/repo.git";
	for (const [url, headers, next] of [
		[interactions, { "x-test-api-key": keyEnv }, decisions],
		[interactions, { "x-test-api-key": keyEnv }, "https://example.com/"],
		[git, { authorization: basic("git", ghEnv) }, `${git}/git-receive-pack`],
	] as const) {
		const first = await onRequest(new Request(url, { headers }));
		if (!(first instanceof Request)) throw new Error("Expected the first request to be forwarded");
		await expectDenied(onRequest, new Request(next, { headers: first.headers }));
	}
});
