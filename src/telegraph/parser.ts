import { Marked, type Token, type Tokens } from "marked";
import type { Node } from "./types.js";

const marked = new Marked({ async: false });

/**
 * Convert a Markdown document to the Telegraph content `Node[]` format.
 * Unsupported constructs (raw HTML, GFM tables, link reference defs) are
 * dropped silently.
 */
export function parse(markdown: string): Node[] {
	// Do not trim leading whitespace: indented code blocks rely on it.
	const tokens = marked.lexer(markdown);
	const out: Node[] = [];
	for (const t of tokens) {
		const node = blockToNode(t);
		if (node == null) continue;
		if (Array.isArray(node)) out.push(...node);
		else out.push(node);
	}
	return out;
}

function blockToNode(t: Token): Node | Node[] | null {
	switch (t.type) {
		case "paragraph": {
			// Lift "image-only" paragraphs to <figure>; this is Telegraph's
			// canonical representation of a standalone image.
			const figure = paragraphAsFigure(t.tokens);
			if (figure) return figure;
			return { tag: "p", children: inlineChildren(t.tokens) };
		}
		case "heading": {
			const tag = t.depth <= 3 ? "h3" : "h4";
			return { tag, children: inlineChildren(t.tokens) };
		}
		case "code":
			return { tag: "pre", children: [{ tag: "code", children: [t.text] }] };
		case "hr":
			return { tag: "hr" };
		case "blockquote":
			return { tag: "blockquote", children: blockChildren(t.tokens) };
		case "list": {
			const tag = t.ordered ? "ol" : "ul";
			const children: Node[] = t.items.map((item: Tokens.ListItem) => ({
				tag: "li" as const,
				children: listItemChildren(item.tokens),
			}));
			return { tag, children };
		}
		// Drop: tables (Telegraph has no <table>), raw HTML (security),
		// link reference definitions (consumed by marked).
		case "table":
		case "html":
		case "def":
		case "space":
			return null;
	}
	return null;
}

function blockChildren(tokens: Token[] | undefined): Node[] {
	if (!tokens) return [];
	const out: Node[] = [];
	for (const t of tokens) {
		const node = blockToNode(t);
		if (node == null) continue;
		if (Array.isArray(node)) out.push(...node);
		else out.push(node);
	}
	return out;
}

/**
 * marked emits list-item children as either a single `text` token (tight list)
 * carrying inline tokens, or a sequence of block tokens (loose list / nested
 * lists). Flatten both into the Telegraph child list.
 */
function listItemChildren(tokens: Token[] | undefined): Node[] {
	if (!tokens) return [];
	const out: Node[] = [];
	for (const t of tokens) {
		// "text" can be either Tokens.Text (has .tokens for inline content)
		// or Tokens.Tag (raw inline HTML, no tokens). The `in` guard tells
		// them apart without an unsafe cast.
		if (t.type === "text" && "tokens" in t && t.tokens) {
			out.push(...inlineChildren(t.tokens));
			continue;
		}
		const node = blockToNode(t);
		if (node == null) continue;
		if (Array.isArray(node)) out.push(...node);
		else out.push(node);
	}
	return out;
}

function paragraphAsFigure(tokens: Token[] | undefined): Node | null {
	if (!tokens || tokens.length !== 1) return null;
	const only = tokens[0];
	if (!only || only.type !== "image") return null;
	const children: Node[] = [{ tag: "img", attrs: { src: only.href } }];
	if (only.text) children.push({ tag: "figcaption", children: [only.text] });
	return { tag: "figure", children };
}

function inlineChildren(tokens: Token[] | undefined): Node[] {
	if (!tokens) return [];
	const out: Node[] = [];
	for (const t of tokens) {
		const node = inlineToNode(t);
		if (node == null) continue;
		out.push(node);
	}
	return out;
}

function inlineToNode(t: Token): Node | null {
	switch (t.type) {
		case "text":
		case "escape":
			return t.text;
		case "strong":
			return { tag: "strong", children: inlineChildren(t.tokens) };
		case "em":
			return { tag: "em", children: inlineChildren(t.tokens) };
		case "del":
			return { tag: "s", children: inlineChildren(t.tokens) };
		case "codespan":
			return { tag: "code", children: [t.text] };
		case "br":
			return { tag: "br" };
		case "link":
			return {
				tag: "a",
				attrs: { href: t.href },
				children: inlineChildren(t.tokens),
			};
		case "image":
			return { tag: "img", attrs: { src: t.href } };
	}
	return null;
}
