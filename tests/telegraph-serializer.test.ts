import { describe, expect, test } from "bun:test";
import { parse } from "../src/telegraph/parser.js";
import { serialize } from "../src/telegraph/serializer.js";

describe("serialize — paragraphs and inline", () => {
	test("plain paragraph", () => {
		expect(serialize([{ tag: "p", children: ["hello"] }])).toBe("hello");
	});

	test("two paragraphs separated by blank line", () => {
		expect(
			serialize([
				{ tag: "p", children: ["a"] },
				{ tag: "p", children: ["b"] },
			]),
		).toBe("a\n\nb");
	});

	test("inline strong / em / del / codespan", () => {
		expect(
			serialize([
				{
					tag: "p",
					children: [
						"a ",
						{ tag: "strong", children: ["bold"] },
						" ",
						{ tag: "em", children: ["italic"] },
						" ",
						{ tag: "s", children: ["gone"] },
						" ",
						{ tag: "code", children: ["fn(x)"] },
					],
				},
			]),
		).toBe("a **bold** *italic* ~~gone~~ `fn(x)`");
	});

	test("link", () => {
		expect(
			serialize([
				{
					tag: "p",
					children: [
						"see ",
						{ tag: "a", attrs: { href: "https://x.test" }, children: ["docs"] },
					],
				},
			]),
		).toBe("see [docs](https://x.test)");
	});
});

describe("serialize — headings", () => {
	test("h3 → ###", () => {
		expect(serialize([{ tag: "h3", children: ["title"] }])).toBe("### title");
	});
	test("h4 → ####", () => {
		expect(serialize([{ tag: "h4", children: ["title"] }])).toBe("#### title");
	});
	test("heading with inline format", () => {
		expect(
			serialize([
				{
					tag: "h3",
					children: [{ tag: "strong", children: ["bold"] }, " title"],
				},
			]),
		).toBe("### **bold** title");
	});
});

describe("serialize — figure/image", () => {
	test("figure with figcaption → ![alt](src)", () => {
		expect(
			serialize([
				{
					tag: "figure",
					children: [
						{ tag: "img", attrs: { src: "https://x.test/cat.jpg" } },
						{ tag: "figcaption", children: ["cat photo"] },
					],
				},
			]),
		).toBe("![cat photo](https://x.test/cat.jpg)");
	});
	test("figure without figcaption → ![](src)", () => {
		expect(
			serialize([
				{
					tag: "figure",
					children: [{ tag: "img", attrs: { src: "https://x.test/cat.jpg" } }],
				},
			]),
		).toBe("![](https://x.test/cat.jpg)");
	});
});

describe("serialize — code blocks", () => {
	test("pre>code → fenced", () => {
		expect(
			serialize([
				{
					tag: "pre",
					children: [{ tag: "code", children: ["foo\nbar"] }],
				},
			]),
		).toBe("```\nfoo\nbar\n```");
	});
});

describe("serialize — lists", () => {
	test("unordered", () => {
		expect(
			serialize([
				{
					tag: "ul",
					children: [
						{ tag: "li", children: ["one"] },
						{ tag: "li", children: ["two"] },
					],
				},
			]),
		).toBe("- one\n- two");
	});

	test("ordered", () => {
		expect(
			serialize([
				{
					tag: "ol",
					children: [
						{ tag: "li", children: ["one"] },
						{ tag: "li", children: ["two"] },
					],
				},
			]),
		).toBe("1. one\n2. two");
	});

	test("nested unordered list", () => {
		expect(
			serialize([
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
			]),
		).toBe("- outer\n  - inner");
	});

	test("li with inline format", () => {
		expect(
			serialize([
				{
					tag: "ul",
					children: [
						{
							tag: "li",
							children: ["a ", { tag: "strong", children: ["b"] }],
						},
					],
				},
			]),
		).toBe("- a **b**");
	});
});

describe("serialize — blockquote / hr / br", () => {
	test("blockquote → > prefix", () => {
		expect(
			serialize([
				{
					tag: "blockquote",
					children: [
						{
							tag: "p",
							children: ["quoted ", { tag: "strong", children: ["bold"] }],
						},
					],
				},
			]),
		).toBe("> quoted **bold**");
	});

	test("hr → ---", () => {
		expect(
			serialize([
				{ tag: "p", children: ["a"] },
				{ tag: "hr" },
				{ tag: "p", children: ["b"] },
			]),
		).toBe("a\n\n---\n\nb");
	});

	test("inline br → two-space line break", () => {
		expect(
			serialize([
				{
					tag: "p",
					children: ["line1", { tag: "br" }, "line2"],
				},
			]),
		).toBe("line1  \nline2");
	});
});

describe("serialize — Telegraph tags without Markdown equivalents", () => {
	test("u — underline → emit children only (no underline in MD)", () => {
		expect(
			serialize([
				{
					tag: "p",
					children: ["a ", { tag: "u", children: ["under"] }, " b"],
				},
			]),
		).toBe("a under b");
	});

	test("b → strong (alias)", () => {
		expect(
			serialize([
				{ tag: "p", children: [{ tag: "b", children: ["bold"] }] },
			]),
		).toBe("**bold**");
	});

	test("i → em (alias)", () => {
		expect(
			serialize([
				{ tag: "p", children: [{ tag: "i", children: ["em"] }] },
			]),
		).toBe("*em*");
	});

	test("aside → emit children as paragraph (no MD equivalent)", () => {
		expect(
			serialize([
				{
					tag: "aside",
					children: [{ tag: "p", children: ["sidebar"] }],
				},
			]),
		).toBe("sidebar");
	});

	test("iframe → emit src as a link", () => {
		expect(
			serialize([
				{
					tag: "p",
					children: [
						{ tag: "iframe", attrs: { src: "/embed/youtube?url=https%3A%2F%2Fyoutu.be%2Fx" } },
					],
				},
			]),
		).toBe("[/embed/youtube?url=https%3A%2F%2Fyoutu.be%2Fx](/embed/youtube?url=https%3A%2F%2Fyoutu.be%2Fx)");
	});
});

describe("serialize — round-trip fidelity", () => {
	test("complex doc round-trips through parse", () => {
		const md = [
			"# Title",
			"",
			"Intro **bold** and *em* text.",
			"",
			"## Section",
			"",
			"```",
			"const x = 1;",
			"```",
			"",
			"- one",
			"- two",
			"  - nested",
			"",
			"> a quote",
			"",
			"---",
			"",
			"Final.",
		].join("\n");

		const nodes = parse(md);
		const back = parse(serialize(nodes));
		expect(back).toEqual(nodes);
	});
});
