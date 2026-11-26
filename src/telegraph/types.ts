import { arr, bool, compile, int, obj, oneOf, opt, str, unknown as unknownValue, type Static } from "@earendil-works/pi-schema";

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
const nodeElement = compile(obj({ tag: oneOf(SUPPORTED_TAGS), ...elementFields }, { open: true }));

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

function isNode(value: unknown): value is Node {
	return typeof value === "string" || (nodeElement.check(value) && (value.children?.every(isNode) ?? true));
}

const accessToken = { access_token: str({ minLength: 1 }) };
export const accessTokenSchema = obj(accessToken, { open: true });
const accountIdentity = { short_name: str(), author_name: str(), ...accessToken };
export const storedAccountSchema = obj(accountIdentity, { open: true });
export const createdAccountSchema = obj({
	...accountIdentity,
	author_url: opt(str()),
	auth_url: opt(str()),
}, { open: true });

export type CreatedAccount = Static<typeof createdAccountSchema>;
export type Account = Omit<CreatedAccount, "access_token" | "auth_url">;
export type AccessToken = Pick<CreatedAccount, "access_token">;
export type AuthUrl = Required<Pick<CreatedAccount, "auth_url">>;

const pageCount = int({ minimum: 0 });
export type PageCount = { page_count: Static<typeof pageCount> };

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
export type PageList = Static<typeof pageListSchema>;

const page = compile(pageSchema);

export function isPageWithContent(value: unknown): value is Page<true> {
	if (!page.check(value) || !("content" in value)) return false;
	return typeof value.content === "string" || (Array.isArray(value.content) && value.content.every(isNode));
}

export type RenderablePage = Page & { content?: string | RenderableNode[] | null };

/** A displayable page need not have a body or use only the tags we publish. */
export function isRenderablePage(value: unknown): value is RenderablePage {
	if (!page.check(value)) return false;
	if (!("content" in value)) return true;
	const { content } = value;
	return content == null || typeof content === "string" || (Array.isArray(content) && content.every(isRenderableNode));
}
