import { createHttpHooks } from "@earendil-works/gondolin";
import { arr, compile, map, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import { SandboxConfigError } from "./sandbox.js";

const secretSchema = obj({
	/** Host-only value. An absent or blank value disables this secret. */
	value: opt(str()),
	hosts: arr(str(), { minItems: 1 }),
});

type SecretFields = Static<typeof secretSchema>;
export type SandboxWebSecret = Omit<SecretFields, "hosts"> & { hosts: Readonly<SecretFields["hosts"]> };

type SecretEnvName = string & { readonly __brand: "SecretEnvName" };
export type ActiveSandboxWebSecret = SandboxWebSecret & { env: SecretEnvName; value: string };

const secretConfig = compile(map(secretSchema));

const ROUTING_HEADERS = new Set([
	"connection", "content-length", "forwarded", "host", "keep-alive", "proxy-authorization", "proxy-connection",
	"te", "trailer", "transfer-encoding", "upgrade", "x-forwarded-host",
]);

function invalidSecret(reason: string): never {
	throw new SandboxConfigError(`Invalid sandbox web secret: ${reason}`);
}

function isSecretEnvName(name: string): name is SecretEnvName {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.toLowerCase() !== "__proto__";
}

/** Validate the scope even for disabled secrets, without logging config values. */
export function normalizeSandboxWebSecrets(config: unknown = {}): ActiveSandboxWebSecret[] {
	if (!secretConfig.check(config)) {
		invalidSecret("expected a map of environment variables to nonempty hostname lists and optional string values");
	}
	const names = new Set<string>();
	const secrets: ActiveSandboxWebSecret[] = [];
	for (const [env, secret] of Object.entries(config)) {
		const name = env.toLowerCase();
		if (!isSecretEnvName(env) || names.has(name)) {
			invalidSecret("expected distinct environment variable names");
		}
		names.add(name);
		const hosts = secret.hosts.map((raw) => {
			const hostname = raw.toLowerCase();
			if (!/^[a-z0-9.-]+$/.test(hostname) || URL.parse(`https://${hostname}`)?.hostname !== hostname || hostname.endsWith(".")) {
				invalidSecret("use exact hostnames without wildcards, ports, or paths");
			}
			return hostname;
		});
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
export function createSandboxWebSecretHooks(secrets: readonly ActiveSandboxWebSecret[]) {
	if (secrets.length === 0) return undefined;
	const { env, httpHooks } = createHttpHooks({
		secretPlaceholderMode: "unique",
		secrets: Object.fromEntries(secrets.map(({ env, value, hosts }) => [env, { value, hosts: [...hosts] }])),
	});
	const scopedSecrets = secrets.map((secret) => {
		const placeholder = env[secret.env];
		if (!placeholder) invalidSecret("expected a generated placeholder for each enabled credential");
		return { ...secret, placeholder };
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
			for (const { value: secret, placeholder, hosts } of scopedSecrets) {
				// Redirected requests can retain plaintext or Basic-encoded credentials.
				if (value.includes(secret) || basic?.includes(secret)) return denied();
				if (!value.includes(placeholder) && !basic?.includes(placeholder)) continue;
				if (!secureAuthority || !hosts.includes(url.hostname) || ROUTING_HEADERS.has(name)) return denied();
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
