import { expect, test } from "bun:test";
import { applyGondolinCredential } from "../src/gondolin-credential.js";

const credential = {
	env: "TEST_API_KEY",
	value: "fixture-host-only-key-not-a-real-credential",
	url: "https://api.example.com/v1/interactions",
	header: "x-test-api-key",
};
const placeholder = "fixture-vm-placeholder";

test("fills only the configured header on the exact HTTPS POST", async () => {
	const request = new Request(credential.url, {
		method: "POST",
		headers: { "x-test-api-key": placeholder, "content-type": "application/json" },
		body: JSON.stringify({ label: placeholder }),
	});
	const forwarded = applyGondolinCredential(request, credential, placeholder);
	if (!(forwarded instanceof Request)) throw new Error("Expected the allowed request to be forwarded");
	expect(forwarded.headers.get("x-test-api-key")).toBe(credential.value);
	expect(await forwarded.json()).toEqual({ label: placeholder });
});

test("denies requests that would place the credential on another destination, protocol, or header", async () => {
	const cases = [
		new Request("https://example.com/v1/interactions", { method: "POST", headers: { "x-test-api-key": placeholder } }),
		new Request("http://api.example.com/v1/interactions", { method: "POST", headers: { "x-test-api-key": placeholder } }),
		new Request("https://api.example.com/v1/models", { method: "POST", headers: { "x-test-api-key": placeholder } }),
		new Request(credential.url, { headers: { "x-test-api-key": placeholder } }),
		new Request(credential.url, { method: "POST", headers: { "x-other-header": placeholder } }),
		new Request(credential.url, { method: "POST", headers: { "x-test-api-key": placeholder, "x-other-header": placeholder } }),
		new Request("https://example.com/v1/interactions", { method: "POST", headers: { "x-test-api-key": credential.value } }),
	];
	for (const request of cases) {
		const result = applyGondolinCredential(request, credential, placeholder);
		if (!(result instanceof Response)) throw new Error("Expected credential misuse to be blocked locally");
		expect(result.status).toBe(403);
		expect(await result.text()).not.toContain(credential.value);
	}
});

test("leaves an unrelated public request unchanged", () => {
	const request = new Request("https://example.com/?label=" + placeholder, { headers: { authorization: "Bearer unrelated-fixture" } });
	const result = applyGondolinCredential(request, credential, placeholder);
	expect(result).toBe(request);
	expect(request.headers.get("authorization")).toBe("Bearer unrelated-fixture");
	expect(request.headers.get("x-test-api-key")).toBeNull();
	expect(new URL(request.url).searchParams.get("label")).toBe(placeholder);
});

test("does not replay a credential already added by the host", () => {
	const first = new Request(credential.url, { method: "POST", headers: { "x-test-api-key": placeholder } });
	const forwarded = applyGondolinCredential(first, credential, placeholder);
	if (!(forwarded instanceof Request)) throw new Error("Expected the first request to be forwarded");
	const replay = new Request(credential.url, { method: "POST", headers: forwarded.headers });
	const blocked = applyGondolinCredential(replay, credential, placeholder);
	if (!(blocked instanceof Response)) throw new Error("Expected replay of an injected credential to be blocked");
	expect(blocked.status).toBe(403);
});
