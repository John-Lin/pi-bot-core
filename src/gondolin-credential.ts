import { createHttpHooks } from "@earendil-works/gondolin";
import { SandboxConfigError } from "./sandbox.js";

export interface GondolinWebSecret {
	/** Host-only value. An absent or blank value disables this secret. */
	value?: string;
	hosts: readonly string[];
	header: string;
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
		if (!secret || Object.keys(secret).some((key) => key !== "hosts" && key !== "header" && key !== "value")) {
			invalidSecret("expected only hosts, header, and an optional value");
		}
		const header = typeof secret.header === "string" ? secret.header.toLowerCase() : "";
		if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header) || ROUTING_HEADERS.has(header)) {
			invalidSecret("expected an application header");
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
			secrets.push({ env, value, hosts, header });
		}
	}
	return secrets;
}

function isSecretDestination(url: URL, hosts: readonly string[]): boolean {
	return url.protocol === "https:" && !url.port && !url.username && !url.password && hosts.includes(url.hostname);
}

function decodeBasic(name: string, value: string): string | undefined {
	if (name !== "authorization" && name !== "proxy-authorization") return;
	const token = /^Basic\s+(\S+)\s*$/i.exec(value)?.[1];
	return token && Buffer.from(token, "base64").toString("utf8");
}

function permitsPlaceholder(value: string, basic: string | undefined, secret: ActiveGondolinSecret, placeholder: string): boolean {
	if (secret.header !== "authorization") return value === placeholder;
	if (basic === undefined) return /^(?:Bearer|token)\s+(\S+)$/i.exec(value)?.[1] === placeholder;
	const colon = basic.indexOf(":");
	return colon > 0 && basic.indexOf(placeholder) === colon + 1 && basic.slice(colon + 1) === placeholder && !value.includes(placeholder);
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
		const headers = [...request.headers].map(([name, value]) => ({ name, value, basic: decodeBasic(name, value) }));
		let usesSecret = false;
		for (const secret of secrets) {
			const placeholder = env[secret.env]!;
			// Redirected requests can retain plaintext or Basic-encoded credentials.
			if (headers.some(({ value, basic }) => value.includes(secret.value) || basic?.includes(secret.value))) return denied();
			const references = headers.filter(({ value, basic }) => value.includes(placeholder) || basic?.includes(placeholder));
			if (references.length === 0) continue;
			const [reference] = references;
			if (references.length !== 1 || reference?.name !== secret.header ||
				!permitsPlaceholder(reference.value, reference.basic, secret, placeholder) ||
				!isSecretDestination(url, secret.hosts) || (host !== null && host.toLowerCase() !== url.host)) {
				return denied();
			}
			usesSecret = true;
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
