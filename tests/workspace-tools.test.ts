import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecOptions } from "../src/sandbox.js";
import { HostExecutor } from "./helpers/host-executor.js";
import { createBashTool } from "../src/tools/bash.js";
import { createReadTool } from "../src/tools/read.js";

let directory: string;
let file: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-bot-tools-"));
	file = join(directory, "report.txt");
});

afterEach(() => rmSync(directory, { force: true, recursive: true }));

function spillInto(path: string) {
	return createBashTool(Object.assign(new HostExecutor(), {
		async saveOutput(output: string, signal?: AbortSignal) {
			await writeFile(path, output, { signal });
			return path;
		},
	}));
}

const longCommand = "i=0; while [ $i -lt 2001 ]; do echo line; i=$((i+1)); done; echo last";

test("bash returns truncated output when spilling fails", async () => {
	const result = await spillInto(join(directory, "missing", "output")).execute("bash", {
		label: "Produce long output",
		command: longCommand,
	});
	expect(result.content[0]?.text).toContain("last\n");
	expect(result.content[0]?.text).toContain("Full output could not be saved");
	expect(result.details?.fullOutputPath).toBeUndefined();
});

test("bash reports the original exit code and output when spilling fails", async () => {
	await expect(spillInto(join(directory, "missing", "output")).execute("bash", {
		label: "Produce long output and fail",
		command: `${longCommand}; exit 7`,
	})).rejects.toThrow(/last\n[\s\S]*Full output could not be saved[\s\S]*Command exited with code 7/);
});

test("bash only advertises a spill path supplied by its executor", async () => {
	const host = new HostExecutor();
	const tool = createBashTool({ exec: host.exec.bind(host), getWorkspacePath: host.getWorkspacePath.bind(host) });
	const result = await tool.execute("bash", { label: "Generate output", command: longCommand });
	try {
		expect(result.content[0]?.text).toContain("Full output could not be saved");
		expect(result.details?.fullOutputPath).toBeUndefined();
	} finally {
		const spill = result.details?.fullOutputPath;
		if (spill) rmSync(spill);
	}
});

test("host bash saves a complete result at a readable path", async () => {
	const result = await createBashTool(new HostExecutor()).execute("bash", { label: "Generate output", command: longCommand });
	const path = result.details?.fullOutputPath;
	expect(path).toBeDefined();
	if (!path) return;
	try {
		expect(await readFile(path, "utf8")).toBe("line\n".repeat(2001) + "last\n");
	} finally {
		rmSync(path);
	}
});

test("read never returns a partial line at the byte boundary", async () => {
	writeFileSync(file, "first\n" + "x".repeat(51_300) + "\nthird");
	const stdoutSizes: number[] = [];
	const read = createReadTool(new class extends HostExecutor {
		override async exec(command: string, options?: ExecOptions) {
			const result = await super.exec(command, options);
			stdoutSizes.push(Buffer.byteLength(result.stdout));
			return result;
		}
	}());
	const result = await read.execute("read", { label: "Read two lines", path: file, limit: 2 });
	expect(result.content).toEqual([{ type: "text", text: "first\n\n[Showing lines 1-1 of 3 (50.0KB limit). Use offset=2 to continue]" }]);
	expect(result.details?.truncation).toMatchObject({ totalBytes: 51_312, totalLines: 3 });
	expect(Math.max(...stdoutSizes)).toBeLessThan(51_203);
	const oversized = await read.execute("read", { label: "Read the oversized line", path: file, offset: 2, limit: 1 });
	expect(oversized.content[0]).toEqual({ type: "text", text: expect.stringContaining("Line 2 exceeds 50.0KB limit") });
	const next = await read.execute("read", { label: "Read after the oversized line", path: file, offset: 3 });
	expect(next.content).toEqual([{ type: "text", text: "third" }]);
});

test("read does not count a trailing newline as an extra line", async () => {
	writeFileSync(file, "first\nsecond\n");
	const read = createReadTool(new HostExecutor());
	const result = await read.execute("read", { label: "Read the final line", path: file, offset: 2, limit: 1 });
	expect(result.content).toEqual([{ type: "text", text: "second" }]);
	await expect(read.execute("read", { label: "Read past the end", path: file, offset: 3 })).rejects.toThrow("2 lines total");
});

test("read returns empty content for an empty file", async () => {
	writeFileSync(file, "");
	const result = await createReadTool(new HostExecutor()).execute("read", { label: "Read empty file", path: file });
	expect(result.content).toEqual([{ type: "text", text: "" }]);
});

test("read surfaces a pipeline error if the file changes after counting", async () => {
	writeFileSync(file, "first\n");
	const read = createReadTool(new class extends HostExecutor {
		private counted = false;
		override async exec(command: string, options?: ExecOptions) {
			const result = await super.exec(command, options);
			if (!this.counted) {
				this.counted = true;
				rmSync(file);
				mkdirSync(file);
			}
			return result;
		}
	}());
	await expect(read.execute("read", { label: "Read changing file", path: file })).rejects.toThrow(/is a directory|error reading stdin/i);
});

test("read paginates at the default line limit", async () => {
	writeFileSync(file, "line\n".repeat(2000) + "last");
	const read = createReadTool(new HostExecutor());
	const result = await read.execute("read", { label: "Read the first page", path: file });
	expect(result.content).toEqual([{ type: "text", text: "line\n".repeat(1999) + "line\n\n[Showing lines 1-2000 of 2001. Use offset=2001 to continue]" }]);
	const next = await read.execute("read", { label: "Read the last page", path: file, offset: 2001 });
	expect(next.content).toEqual([{ type: "text", text: "last" }]);
});
