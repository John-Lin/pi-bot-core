import { describe, expect, test } from "bun:test";
import { parse } from "../src/telegraph/parser.js";

describe("parse — paragraphs and text", () => {
	test("plain paragraph wraps text in <p>", () => {
		expect(parse("Hello world")).toEqual([{ tag: "p", children: ["Hello world"] }]);
	});

	test("empty input → empty Node[]", () => {
		expect(parse("")).toEqual([]);
		expect(parse("   \n\n  ")).toEqual([]);
	});

	test("two paragraphs separated by blank line", () => {
		expect(parse("First.\n\nSecond.")).toEqual([
			{ tag: "p", children: ["First."] },
			{ tag: "p", children: ["Second."] },
		]);
	});
});

describe("parse — inline formatting", () => {
	test("**bold** → strong", () => {
		expect(parse("a **bold** word")).toEqual([
			{
				tag: "p",
				children: ["a ", { tag: "strong", children: ["bold"] }, " word"],
			},
		]);
	});

	test("*italic* → em", () => {
		expect(parse("a *slanty* word")).toEqual([
			{
				tag: "p",
				children: ["a ", { tag: "em", children: ["slanty"] }, " word"],
			},
		]);
	});

	test("~~struck~~ → s", () => {
		expect(parse("a ~~gone~~ word")).toEqual([
			{
				tag: "p",
				children: ["a ", { tag: "s", children: ["gone"] }, " word"],
			},
		]);
	});

	test("inline `code` → code", () => {
		expect(parse("call `fn(x)` here")).toEqual([
			{
				tag: "p",
				children: ["call ", { tag: "code", children: ["fn(x)"] }, " here"],
			},
		]);
	});

	test("nested bold inside italic", () => {
		expect(parse("*a **b** c*")).toEqual([
			{
				tag: "p",
				children: [
					{
						tag: "em",
						children: ["a ", { tag: "strong", children: ["b"] }, " c"],
					},
				],
			},
		]);
	});
});

describe("parse — headings", () => {
	test("h1 and h2 downgrade to h3", () => {
		expect(parse("# title")).toEqual([{ tag: "h3", children: ["title"] }]);
		expect(parse("## title")).toEqual([{ tag: "h3", children: ["title"] }]);
	});

	test("h3 stays h3", () => {
		expect(parse("### title")).toEqual([{ tag: "h3", children: ["title"] }]);
	});

	test("h4, h5, h6 collapse to h4", () => {
		expect(parse("#### title")).toEqual([{ tag: "h4", children: ["title"] }]);
		expect(parse("##### title")).toEqual([{ tag: "h4", children: ["title"] }]);
		expect(parse("###### title")).toEqual([{ tag: "h4", children: ["title"] }]);
	});

	test("heading carries inline formatting", () => {
		expect(parse("# **bold** title")).toEqual([
			{
				tag: "h3",
				children: [{ tag: "strong", children: ["bold"] }, " title"],
			},
		]);
	});
});

describe("parse — links and images", () => {
	test("[text](url) → a with href", () => {
		expect(parse("see [docs](https://x.test) plz")).toEqual([
			{
				tag: "p",
				children: [
					"see ",
					{ tag: "a", attrs: { href: "https://x.test" }, children: ["docs"] },
					" plz",
				],
			},
		]);
	});

	test("autolink <url> → a with href", () => {
		expect(parse("visit <https://x.test>")).toEqual([
			{
				tag: "p",
				children: [
					"visit ",
					{ tag: "a", attrs: { href: "https://x.test" }, children: ["https://x.test"] },
				],
			},
		]);
	});

	test("![alt](url) → figure / img / figcaption", () => {
		expect(parse("![cat photo](https://x.test/cat.jpg)")).toEqual([
			{
				tag: "figure",
				children: [
					{ tag: "img", attrs: { src: "https://x.test/cat.jpg" } },
					{ tag: "figcaption", children: ["cat photo"] },
				],
			},
		]);
	});

	test("image without alt skips figcaption", () => {
		expect(parse("![](https://x.test/cat.jpg)")).toEqual([
			{
				tag: "figure",
				children: [{ tag: "img", attrs: { src: "https://x.test/cat.jpg" } }],
			},
		]);
	});
});

describe("parse — code blocks", () => {
	test("fenced code block → <pre><code>text</code></pre>", () => {
		expect(parse("```\nfoo\nbar\n```")).toEqual([
			{
				tag: "pre",
				children: [{ tag: "code", children: ["foo\nbar"] }],
			},
		]);
	});

	test("language fence is ignored (Telegraph has no syntax highlighting)", () => {
		expect(parse("```ts\nconst x = 1;\n```")).toEqual([
			{
				tag: "pre",
				children: [{ tag: "code", children: ["const x = 1;"] }],
			},
		]);
	});

	test("indented code block also lifts to <pre><code>", () => {
		expect(parse("    indented")).toEqual([
			{
				tag: "pre",
				children: [{ tag: "code", children: ["indented"] }],
			},
		]);
	});
});

describe("parse — lists", () => {
	test("unordered list → ul/li", () => {
		expect(parse("- one\n- two")).toEqual([
			{
				tag: "ul",
				children: [
					{ tag: "li", children: ["one"] },
					{ tag: "li", children: ["two"] },
				],
			},
		]);
	});

	test("ordered list → ol/li", () => {
		expect(parse("1. one\n2. two")).toEqual([
			{
				tag: "ol",
				children: [
					{ tag: "li", children: ["one"] },
					{ tag: "li", children: ["two"] },
				],
			},
		]);
	});

	test("list item carries inline formatting", () => {
		expect(parse("- a **b**")).toEqual([
			{
				tag: "ul",
				children: [
					{
						tag: "li",
						children: ["a ", { tag: "strong", children: ["b"] }],
					},
				],
			},
		]);
	});

	test("nested list", () => {
		expect(parse("- outer\n  - inner")).toEqual([
			{
				tag: "ul",
				children: [
					{
						tag: "li",
						children: [
							"outer",
							{
								tag: "ul",
								children: [{ tag: "li", children: ["inner"] }],
							},
						],
					},
				],
			},
		]);
	});
});

describe("parse — blockquote / hr", () => {
	test("blockquote wraps inner blocks", () => {
		expect(parse("> quoted **bold**")).toEqual([
			{
				tag: "blockquote",
				children: [
					{
						tag: "p",
						children: ["quoted ", { tag: "strong", children: ["bold"] }],
					},
				],
			},
		]);
	});

	test("--- horizontal rule → hr", () => {
		expect(parse("a\n\n---\n\nb")).toEqual([
			{ tag: "p", children: ["a"] },
			{ tag: "hr" },
			{ tag: "p", children: ["b"] },
		]);
	});
});

describe("parse — drop unsupported", () => {
	test("GFM table is dropped", () => {
		const md = "| a | b |\n|---|---|\n| 1 | 2 |";
		expect(parse(md)).toEqual([]);
	});

	test("raw HTML block is dropped", () => {
		expect(parse("<div>raw</div>")).toEqual([]);
	});

	test("link reference definition produces no node", () => {
		expect(parse("[ref][1]\n\n[1]: https://x.test")).toEqual([
			{
				tag: "p",
				children: [
					{ tag: "a", attrs: { href: "https://x.test" }, children: ["ref"] },
				],
			},
		]);
	});
});

