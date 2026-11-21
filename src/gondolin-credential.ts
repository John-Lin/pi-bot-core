export interface GondolinWebCredential {
	env: string;
	value: string;
	url: string;
	header: string;
}

const ROUTING_HEADERS = new Set([
	"connection", "content-length", "forwarded", "host", "keep-alive", "proxy-connection",
	"te", "trailer", "transfer-encoding", "upgrade", "x-forwarded-host",
]);

/** Fill a single request header; never expand placeholders in another header, URL, or body. */
export function applyGondolinCredential(request: Request, credential: GondolinWebCredential, placeholder: string): Request | Response {
	const key = credential.value.trim();
	const values = [...request.headers.values()];
	// Redirected hops can retain custom headers with the normalized value sent by Fetch.
	const carriesKey = key !== "" && values.some((value) => value.includes(key));
	const markerCount = values.filter((value) => value.includes(placeholder)).length;
	if (!carriesKey && markerCount === 0) return request;
	const header = credential.header.toLowerCase();
	const host = request.headers.get("host");
	if (!key || carriesKey || request.method !== "POST" || request.url !== credential.url || markerCount !== 1 ||
		ROUTING_HEADERS.has(header) || request.headers.get(header) !== placeholder ||
		(host !== null && host.toLowerCase() !== new URL(credential.url).host)) {
		return new Response("Gondolin web credential is not allowed for this request", { status: 403 });
	}
	// Let the HTTP client derive the upstream authority from the approved URL.
	request.headers.delete("host");
	request.headers.set(header, key);
	return request;
}
