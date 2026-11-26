import { arr, bool, compile, int, obj, opt, str, unknown as unknownValue, type Static } from "@earendil-works/pi-schema";

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

const elementFields = {
	attrs: opt(obj({ href: opt(str()), src: opt(str()) }, { open: true })),
	children: opt(arr(unknownValue())),
};
const renderableElementSchema = obj({ tag: str(), ...elementFields }, { open: true });
const renderableElement = compile(renderableElementSchema);

export interface RenderableElement extends Omit<Static<typeof renderableElementSchema>, "children"> {
	children?: RenderableNode[];
}
export type RenderableNode = string | RenderableElement;

export interface NodeElement extends RenderableElement {
	tag: SupportedTag;
	children?: Node[];
}
export type Node = string | NodeElement;

function isRenderableNode(value: unknown): value is RenderableNode {
	return typeof value === "string" || (renderableElement.check(value) && (value.children?.every(isRenderableNode) ?? true));
}

const accessToken = { access_token: str({ minLength: 1 }) };
export const accessTokenSchema = obj(accessToken, { open: true });
const accountNames = { short_name: str(), author_name: str() };
export const storedAccountSchema = obj({
	...accessToken,
	short_name: opt(accountNames.short_name),
	author_name: opt(accountNames.author_name),
}, { open: true });
export const createdAccountSchema = obj({
	...accountNames,
	...accessToken,
	author_url: opt(str()),
	auth_url: opt(str()),
}, { open: true });

export type CreatedAccount = Static<typeof createdAccountSchema>;
export interface Account extends Omit<CreatedAccount, "access_token" | "auth_url"> {}
export interface AccessToken extends Pick<CreatedAccount, "access_token"> {}
export interface AuthUrl extends Required<Pick<CreatedAccount, "auth_url">> {}

const pageCount = int({ minimum: 0 });
export interface PageCount {
	page_count: Static<typeof pageCount>;
}

export const pageSchema = obj({
	path: str(),
	url: str(),
	title: str(),
	description: str(),
	author_name: opt(str()),
	author_url: opt(str()),
	image_url: opt(str()),
	views: int({ minimum: 0 }),
	can_edit: opt(bool()),
}, { open: true });

export type Page<T extends boolean = false> = Static<typeof pageSchema> &
	(T extends true ? { content: string | Node[] } : unknown);

export const pageListSchema = obj({ total_count: pageCount, pages: arr(pageSchema) }, { open: true });
export interface PageList extends Static<typeof pageListSchema> {}

const page = compile(pageSchema);

export type RenderablePage = Page & { content?: string | RenderableNode[] | null };

/** A displayable page need not have a body or use only the tags we publish. */
export function isRenderablePage(value: unknown): value is RenderablePage {
	if (!page.check(value)) return false;
	if (!("content" in value)) return true;
	const { content } = value;
	return content == null || typeof content === "string" || (Array.isArray(content) && content.every(isRenderableNode));
}
