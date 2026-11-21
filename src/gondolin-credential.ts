import { SandboxConfigError } from "./sandbox.js";

export interface GondolinWebCredential {
	env: string;
	value?: string;
	urls: readonly string[];
	header: string;
}

export type ActiveGondolinCredential = GondolinWebCredential & { value: string };

const ROUTING_HEADERS = new Set([
	"connection", "content-length", "forwarded", "host", "keep-alive", "proxy-connection",
	"te", "trailer", "transfer-encoding", "upgrade", "x-forwarded-host",
]);

/** Validate host configuration without including URLs or secret values in errors. */
export function normalizeGondolinCredential(credential: GondolinWebCredential): ActiveGondolinCredential | undefined {
	const header = credential.header.toLowerCase();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential.env) || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header) || ROUTING_HEADERS.has(header)) {
		throw new SandboxConfigError("Invalid Gondolin web credential: expected an environment variable and an application header");
	}
	if (!Array.isArray(credential.urls) || credential.urls.length === 0) {
		throw new SandboxConfigError("Invalid Gondolin web credential: expected at least one exact HTTPS URL");
	}
	const urls = credential.urls.map((raw) => {
		const url = URL.parse(raw);
		if (!url || url.protocol !== "https:" || url.username || url.password || /[?#*]/.test(url.href)) {
			throw new SandboxConfigError("Invalid Gondolin web credential: use exact HTTPS URLs without user info, query, fragment, or wildcard");
		}
		return url.href;
	});
	const value = credential.value?.trim();
	return value ? { ...credential, header, value, urls } : undefined;
}

/** Fill a single request header; never expand placeholders in another header, URL, or body. */
export function applyGondolinCredential(request: Request, credential: ActiveGondolinCredential, placeholder: string): Request | Response {
	const key = credential.value.trim();
	const values = [...request.headers.values()];
	// Redirected hops can retain custom headers with the normalized value sent by Fetch.
	const carriesKey = key !== "" && values.some((value) => value.includes(key));
	const markerCount = values.filter((value) => value.includes(placeholder)).length;
	if (!carriesKey && markerCount === 0) return request;
	const header = credential.header.toLowerCase();
	const host = request.headers.get("host");
	if (!key || carriesKey || request.method !== "POST" || !credential.urls.includes(request.url) || markerCount !== 1 ||
		ROUTING_HEADERS.has(header) || request.headers.get(header) !== placeholder ||
		(host !== null && host.toLowerCase() !== new URL(request.url).host)) {
		return new Response("The workspace credential is not allowed for this request.", { status: 403 });
	}
	// Let the HTTP client derive the upstream authority from the approved URL.
	request.headers.delete("host");
	request.headers.set(header, key);
	return request;
}
