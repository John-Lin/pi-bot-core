import { describe, expect, test } from "bun:test";
import { createAttachTool } from "../src/tools/attach.js";

describe("createAttachTool", () => {
	test("exposes tool with correct identifier and schema keys", () => {
		const { tool } = createAttachTool();
		expect(tool.name).toBe("attach");
		const props = (tool.parameters as any).properties;
		expect(Object.keys(props).sort()).toEqual(["label", "path", "title"].sort());
	});

	test("throws when no uploader is configured", async () => {
		const { tool } = createAttachTool();
		await expect(
			tool.execute!("c", { label: "x", path: "/workspace/42/foo.png" } as any, undefined),
		).rejects.toThrow(/not configured|no active/i);
	});

	test("calls uploader with path and { label, fileName } using explicit title", async () => {
		const { tool, setUploader } = createAttachTool();
		const calls: Array<{ path: string; label: string; fileName: string }> = [];
		setUploader(async (filePath, opts) => {
			calls.push({ path: filePath, label: opts.label, fileName: opts.fileName });
		});

		const out = await tool.execute!(
			"c",
			{ label: "latest chart", path: "/workspace/42/scratch/chart.png", title: "Chart.png" } as any,
			undefined,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.path).toBe("/workspace/42/scratch/chart.png");
		expect(calls[0]!.label).toBe("latest chart");
		expect(calls[0]!.fileName).toBe("Chart.png");
		expect(out.content[0]).toEqual({ type: "text", text: "Attached Chart.png" });
	});

	test("falls back to basename when title is absent", async () => {
		const { tool, setUploader } = createAttachTool();
		let receivedFileName: string | undefined;
		setUploader(async (_p, opts) => {
			receivedFileName = opts.fileName;
		});

		await tool.execute!(
			"c",
			{ label: "pdf", path: "/workspace/42/scratch/report.pdf" } as any,
			undefined,
		);

		expect(receivedFileName).toBe("report.pdf");
	});

	test("honors AbortSignal before upload", async () => {
		const { tool, setUploader } = createAttachTool();
		let called = false;
		setUploader(async () => {
			called = true;
		});
		const ac = new AbortController();
		ac.abort();

		await expect(
			tool.execute!("c", { label: "x", path: "/workspace/42/chart.png" } as any, ac.signal),
		).rejects.toThrow();
		expect(called).toBe(false);
	});

	test("rejects relative paths without invoking uploader", async () => {
		const { tool, setUploader } = createAttachTool();
		let called = false;
		setUploader(async () => {
			called = true;
		});

		await expect(
			tool.execute!("c", { label: "x", path: "scratch/chart.png" } as any, undefined),
		).rejects.toThrow(/absolute/i);
		expect(called).toBe(false);
	});

	test("accepts host-mode absolute paths outside /workspace/", async () => {
		const { tool, setUploader } = createAttachTool();
		const calls: string[] = [];
		setUploader(async (filePath) => {
			calls.push(filePath);
		});

		await tool.execute!(
			"c",
			{ label: "x", path: "/Users/me/data/42/chart.png" } as any,
			undefined,
		);
		expect(calls).toEqual(["/Users/me/data/42/chart.png"]);
	});

	test("setUploader(null) clears the previously set uploader", async () => {
		const { tool, setUploader } = createAttachTool();
		setUploader(async () => {});
		setUploader(null);

		await expect(
			tool.execute!("c", { label: "x", path: "/workspace/42/chart.png" } as any, undefined),
		).rejects.toThrow(/not configured|no active/i);
	});
});
