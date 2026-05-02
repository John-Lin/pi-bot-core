/**
 * Telegraph (telegra.ph) tag whitelist. Anything outside this set is dropped
 * by the API server, so the parser must only emit these tags.
 */
export const SUPPORTED_TAGS = [
	"a",
	"aside",
	"b",
	"blockquote",
	"br",
	"code",
	"em",
	"figcaption",
	"figure",
	"h3",
	"h4",
	"hr",
	"i",
	"iframe",
	"img",
	"li",
	"ol",
	"p",
	"pre",
	"s",
	"strong",
	"u",
	"ul",
	"video",
] as const;

export type SupportedTag = (typeof SUPPORTED_TAGS)[number];

export interface NodeElement {
	tag: SupportedTag;
	attrs?: { href?: string; src?: string };
	children?: Node[];
}

export type Node = string | NodeElement;

export interface Account {
	short_name: string;
	author_name: string;
	author_url?: string;
}

export interface AccessToken {
	access_token: string;
}

export interface AuthUrl {
	auth_url: string;
}

export interface PageCount {
	page_count: number;
}

export type Page<T extends boolean = false> = {
	path: string;
	url: string;
	title: string;
	description: string;
	author_name?: string;
	author_url?: string;
	image_url?: string;
	views: number;
	can_edit?: boolean;
} & (T extends true ? { content: string | Node[] } : Record<never, never>);

export interface PageList {
	total_count: number;
	pages: Page<false>[];
}
