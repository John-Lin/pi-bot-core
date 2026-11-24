import { createHttpHooks } from "@earendil-works/gondolin";
import { SandboxConfigError } from "./sandbox.js";

export interface GondolinWebSecret {
	/** Host-only value. An absent or blank value disables this secret. */
	value?: string;
	hosts: readonly string[];
}

export type ActiveGondolinSecret = GondolinWebSecret & { env: string; value: string };

const ROUTING_HEADERS = new Set([
	"connection", "content-length", "forwarded", "host", "keep-alive", "proxy-authorization", "proxy-connection",
	"te", "trailer", "transfer-encoding", "upgrade", "x-forwarded-host",
]);

function invalidSecret(reason: string): never {
	throw new SandboxConfigError(`Invalid Gondolin web secret: ${reason}`);
}

/** Validate the scope even for disabled secrets, without logging config values. */
export function normalizeGondolinSecrets(config: Readonly<Record<string, GondolinWebSecret>> = {}): ActiveGondolinSecret[] {
	if (!config || typeof config !== "object" || Array.isArray(config)) invalidSecret("expected a map keyed by environment variable");
	const names = new Set<string>();
	const secrets: ActiveGondolinSecret[] = [];
	for (const [env, secret] of Object.entries(config)) {
		const name = env.toLowerCase();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env) || name === "__proto__" || names.has(name)) {
			invalidSecret("expected distinct environment variable names");
		}
		names.add(name);
		if (!secret || Object.keys(secret).some((key) => key !== "hosts" && key !== "value")) {
			invalidSecret("expected only hosts and an optional value");
		}
		if (!Array.isArray(secret.hosts) || secret.hosts.length === 0) invalidSecret("expected at least one exact hostname");
		const hosts = secret.hosts.map((raw: string) => {
			const hostname = typeof raw === "string" ? raw.toLowerCase() : "";
			if (!/^[a-z0-9.-]+$/.test(hostname) || URL.parse(`https://${hostname}`)?.hostname !== hostname || hostname.endsWith(".")) {
				invalidSecret("use exact hostnames without wildcards, ports, or paths");
			}
			return hostname;
		});
		if (secret.value !== undefined && typeof secret.value !== "string") invalidSecret("expected a string value");
		const value = secret.value?.trim();
		if (value) {
			if (!/^[\x20-\x7e]+$/.test(value)) invalidSecret("expected a value safe for an HTTP header");
			secrets.push({ env, value, hosts });
		}
	}
	return secrets;
}

function decodeBasic(name: string, value: string): string | undefined {
	if (name !== "authorization" && name !== "proxy-authorization") return;
	const token = /^Basic\s+(\S+)\s*$/i.exec(value)?.[1];
	return token && Buffer.from(token, "base64").toString("utf8");
}

/** Apply the request boundary before Gondolin expands any placeholder. */
export function createGondolinSecretHooks(secrets: readonly ActiveGondolinSecret[]) {
	if (secrets.length === 0) return undefined;
	const { env, httpHooks } = createHttpHooks({
		secretPlaceholderMode: "unique",
		secrets: Object.fromEntries(secrets.map(({ env, value, hosts }) => [env, { value, hosts: [...hosts] }])),
	});
	const substitute = httpHooks.onRequest;
	httpHooks.onRequest = (request) => {
		const url = new URL(request.url);
		const host = request.headers.get("host");
		const secureAuthority = url.protocol === "https:" && !url.port && !url.username && !url.password &&
			(host === null || host.toLowerCase() === url.host);
		let usesSecret = false;
		for (const [name, value] of request.headers) {
			const basic = decodeBasic(name, value);
			for (const secret of secrets) {
				// Redirected requests can retain plaintext or Basic-encoded credentials.
				if (value.includes(secret.value) || basic?.includes(secret.value)) return denied();
				const placeholder = env[secret.env]!;
				if (!value.includes(placeholder) && !basic?.includes(placeholder)) continue;
				if (!secureAuthority || !secret.hosts.includes(url.hostname) || ROUTING_HEADERS.has(name)) return denied();
				usesSecret = true;
			}
		}
		// Derive upstream authority from the checked URL rather than a guest header.
		if (usesSecret) request.headers.delete("host");
		return substitute?.(request);
	};
	return { env, httpHooks };
}

function denied(): Response {
	return new Response("The workspace credential is not allowed for this request.", { status: 403 });
}
