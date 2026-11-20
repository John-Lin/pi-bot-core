export interface GondolinWebCredential {
	env: string;
	value: string;
	url: string;
	header: string;
}

/** Fill a single request header; never expand placeholders in another header, URL, or body. */
export function applyGondolinCredential(request: Request, credential: GondolinWebCredential, placeholder: string): Request | Response {
	const values = [...request.headers.values()];
	// A redirected hop can retain custom headers from a previous request.
	const carriesKey = values.some((value) => value.includes(credential.value));
	const markerCount = values.filter((value) => value.includes(placeholder)).length;
	if (!carriesKey && markerCount === 0) return request;
	if (carriesKey || request.method !== "POST" || request.url !== credential.url || markerCount !== 1 ||
		request.headers.get(credential.header) !== placeholder) {
		return new Response("Gondolin web credential is not allowed for this request", { status: 403 });
	}
	request.headers.set(credential.header, credential.value);
	return request;
}
