import { createHttpHooks } from "@earendil-works/gondolin";

export interface GondolinPublicWebOptions {
	/** A host credential exposed as a placeholder for one HTTPS POST endpoint. */
	credential?: {
		env: string;
		value: string;
		url: string;
		header: string;
	};
}

export function createGondolinPublicWeb({ credential }: GondolinPublicWebOptions) {
	if (!credential) return createHttpHooks({ blockInternalRanges: true });

	const { env, value, url, header } = credential;
	const target = new URL(url);
	if (target.protocol !== "https:" || target.username || target.password || target.hash || !value) {
		throw new Error("A Gondolin web credential requires an HTTPS endpoint and a nonempty value");
	}
	const policy = createHttpHooks({
		blockInternalRanges: true,
		secrets: { [env]: { value, hosts: [target.hostname] } },
		onRequest(request) {
			// Check the placeholder before substitution, and the real value on redirected hops.
			const marker = policy.env[env]!;
			const matching = [...request.headers].filter(([, content]) => content.includes(marker) || content.includes(value));
			if (matching.length === 0) return;
			const supplied = request.headers.get(header);
			if (request.method !== "POST" || request.url !== target.href || matching.length !== 1 ||
				(supplied !== marker && supplied !== value)) {
				return new Response("Gondolin web credential is not allowed for this request", { status: 403 });
			}
		},
	});
	return policy;
}
