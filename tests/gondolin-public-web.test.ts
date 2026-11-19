import { expect, test } from "bun:test";
import { createGondolinPublicWeb } from "../src/gondolin-public-web.js";

const credential = {
	env: "TEST_API_KEY",
	value: "fixture-host-only-key-not-a-real-credential",
	url: "https://api.example.com/v1/interactions",
	header: "x-test-api-key",
};

test("allows public addresses and rejects private, loopback, and link-local destinations", async () => {
	const { httpHooks, env } = createGondolinPublicWeb({});
	expect(env).toEqual({});
	async function allows(ip: string, family: 4 | 6) {
		return httpHooks.isIpAllowed!({ hostname: "api.example.com", ip, family, port: 443, protocol: "https" });
	}
	expect(await allows("93.184.215.14", 4)).toBe(true);
	for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "169.254.169.254"]) {
		expect(await allows(ip, 4)).toBe(false);
	}
	for (const ip of ["::1", "fe80::1", "fd00::1"]) {
		expect(await allows(ip, 6)).toBe(false);
	}
});

test("substitutes a placeholder only on the configured HTTPS POST and header", async () => {
	const { httpHooks, env } = createGondolinPublicWeb({ credential });
	const placeholder = env.TEST_API_KEY!;
	expect(placeholder).toBeTruthy();
	expect(placeholder).not.toContain(credential.value);

	const request = new Request(credential.url, { method: "POST", headers: { "x-test-api-key": placeholder } });
	const forwarded = await httpHooks.onRequest!(request);
	if (!(forwarded instanceof Request)) throw new Error("Expected the allowed request to be forwarded");
	expect(forwarded.headers.get("x-test-api-key")).toBe(credential.value);
});

test("denies requests that would place the credential on another destination, protocol, or header", async () => {
	const { httpHooks, env } = createGondolinPublicWeb({ credential });
	const placeholder = env.TEST_API_KEY!;
	const cases = [
		new Request("https://example.com/v1/interactions", { method: "POST", headers: { "x-test-api-key": placeholder } }),
		new Request("http://api.example.com/v1/interactions", { method: "POST", headers: { "x-test-api-key": placeholder } }),
		new Request("https://api.example.com/v1/models", { method: "POST", headers: { "x-test-api-key": placeholder } }),
		new Request(credential.url, { headers: { "x-test-api-key": placeholder } }),
		new Request(credential.url, { method: "POST", headers: { "x-other-header": placeholder } }),
		new Request("https://example.com/v1/interactions", { method: "POST", headers: { "x-test-api-key": credential.value } }),
	];
	for (const request of cases) {
		const result = await httpHooks.onRequest!(request);
		if (!(result instanceof Response)) throw new Error("Expected credential misuse to be blocked locally");
		expect(result.status).toBe(403);
		expect(await result.text()).not.toContain(credential.value);
	}

	const request = new Request("https://example.com/");
	const result = await httpHooks.onRequest!(request);
	expect(result).toBe(request);
	expect(request.headers.get("x-test-api-key")).toBeNull();
});

test("does not accept a plaintext destination for a credential", () => {
	expect(() => createGondolinPublicWeb({ credential: { ...credential, url: "http://api.example.com/" } })).toThrow("HTTPS");
});
