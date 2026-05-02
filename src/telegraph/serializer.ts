import type { Node, NodeElement } from "./types.js";

/**
 * Render a Telegraph `Node[]` tree back to Markdown. Designed to round-trip
 * with `parse()` for the subset of Markdown we emit; tags without a Markdown
 * equivalent (u, aside, iframe, video) degrade gracefully so the agent still
 * sees usable text when reading an arbitrary Telegraph page.
 */
export function serialize(nodes: Node[]): string {
	return blocksToMarkdown(nodes).trim();
}

function blocksToMarkdown(nodes: Node[]): string {
	const parts: string[] = [];
	for (const node of nodes) {
		const rendered = blockToMarkdown(node);
		if (rendered === "") continue;
		parts.push(rendered);
	}
	return parts.join("\n\n");
}

function blockToMarkdown(node: Node): string {
	if (typeof node === "string") return node;
	switch (node.tag) {
		case "p":
			return inlineChildren(node);
		case "h3":
			return `### ${inlineChildren(node)}`;
		case "h4":
			return `#### ${inlineChildren(node)}`;
		case "hr":
			return "---";
		case "blockquote":
			return prefixLines(blocksToMarkdown(node.children ?? []), "> ");
		case "pre": {
			const code = node.children?.[0];
			const text = typeof code === "string"
				? code
				: code && typeof code === "object" && code.tag === "code"
					? (code.children ?? []).filter((c): c is string => typeof c === "string").join("")
					: "";
			return "```\n" + text + "\n```";
		}
		case "figure":
			return figureToMarkdown(node);
		case "ul":
		case "ol":
			return listToMarkdown(node);
		case "aside":
			return blocksToMarkdown(node.children ?? []);
		default:
			// Unknown block tag — fall back to inline rendering of children
			return inlineChildren(node);
	}
}

function figureToMarkdown(node: NodeElement): string {
	const children = node.children ?? [];
	let src = "";
	let caption = "";
	for (const c of children) {
		if (typeof c !== "object") continue;
		if (c.tag === "img") src = c.attrs?.src ?? "";
		else if (c.tag === "figcaption") caption = inlineChildren(c);
	}
	return `![${caption}](${src})`;
}

function listToMarkdown(node: NodeElement): string {
	const items = node.children ?? [];
	const ordered = node.tag === "ol";
	const lines: string[] = [];
	let i = 0;
	for (const item of items) {
		i += 1;
		if (typeof item !== "object" || item.tag !== "li") continue;
		const marker = ordered ? `${i}.` : "-";
		lines.push(renderListItem(item, marker));
	}
	return lines.join("\n");
}

function renderListItem(item: NodeElement, marker: string): string {
	const children = item.children ?? [];
	const inlineParts: string[] = [];
	const blockParts: string[] = [];
	for (const c of children) {
		if (typeof c === "string") {
			inlineParts.push(c);
		} else if (isInline(c)) {
			inlineParts.push(inlineToMarkdown(c));
		} else {
			blockParts.push(blockToMarkdown(c));
		}
	}
	const head = `${marker} ${inlineParts.join("")}`;
	if (blockParts.length === 0) return head;
	const indent = " ".repeat(marker.length + 1);
	const indented = blockParts
		.map((b) => prefixLines(b, indent))
		.join("\n");
	return `${head}\n${indented}`;
}

function inlineChildren(node: NodeElement): string {
	const out: string[] = [];
	for (const c of node.children ?? []) {
		if (typeof c === "string") out.push(c);
		else out.push(inlineToMarkdown(c));
	}
	return out.join("");
}

function inlineToMarkdown(node: NodeElement): string {
	switch (node.tag) {
		case "strong":
		case "b":
			return `**${inlineChildren(node)}**`;
		case "em":
		case "i":
			return `*${inlineChildren(node)}*`;
		case "s":
			return `~~${inlineChildren(node)}~~`;
		case "code":
			return `\`${inlineChildren(node)}\``;
		case "br":
			return "  \n";
		case "a": {
			const href = node.attrs?.href ?? "";
			return `[${inlineChildren(node)}](${href})`;
		}
		case "img": {
			const src = node.attrs?.src ?? "";
			return `![](${src})`;
		}
		case "iframe":
		case "video": {
			const src = node.attrs?.src ?? "";
			return `[${src}](${src})`;
		}
		case "u":
			// No Markdown equivalent — emit raw children
			return inlineChildren(node);
		default:
			return inlineChildren(node);
	}
}

function isInline(node: NodeElement): boolean {
	switch (node.tag) {
		case "a":
		case "b":
		case "br":
		case "code":
		case "em":
		case "i":
		case "iframe":
		case "img":
		case "s":
		case "strong":
		case "u":
		case "video":
			return true;
		default:
			return false;
	}
}

function prefixLines(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}
