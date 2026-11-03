import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAgentSettings } from "pi-bot-core/agent-settings";
import { loadAgentSettings as loadFromRoot } from "../src/index.js";

let workspace: string;
let path: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "pi-bot-agent-settings-"));
	path = join(workspace, "agent-settings.json");
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
	writeFileSync(path, JSON.stringify(value));
}

function expectInvalid(value: unknown, field: string): void {
	writeConfig(value);
	expect(() => loadAgentSettings(path)).toThrow(path);
	expect(() => loadAgentSettings(path)).toThrow(field);
}

describe("loadAgentSettings", () => {
	test("is available from the root and agent-settings exports", () => {
		expect(loadFromRoot).toBe(loadAgentSettings);
	});

	test("separates the bot context window from SDK settings without changing the file", () => {
		const config = {
			contextWindow: 272000,
			compaction: { reserveTokens: 82000, keepRecentTokens: 20000 },
		};
		writeConfig(config);
		const content = readFileSync(path, "utf8");
		const loaded = loadAgentSettings(path);
		expect(loaded).toEqual({
			contextWindow: 272000,
			settings: { compaction: { reserveTokens: 82000, keepRecentTokens: 20000 } },
		});
		const contextWindow: number | undefined = loaded.contextWindow;
		expect(contextWindow).toBe(272000);
		const manager = SettingsManager.inMemory(loaded.settings);
		expect(manager.getCompactionSettings()).toMatchObject(config.compaction);
		expect(manager.getSettings()).not.toHaveProperty("contextWindow");
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	test("leaves omitted fields unset so the SDK retains its defaults", () => {
		writeConfig({});
		const loaded = loadAgentSettings(path);
		expect(loaded).toEqual({ contextWindow: undefined, settings: {} });
		expect(SettingsManager.inMemory(loaded.settings).getCompactionSettings()).toEqual(
			SettingsManager.inMemory().getCompactionSettings(),
		);
	});

	for (const compaction of [{}, { reserveTokens: 0 }, { keepRecentTokens: 0 }]) {
		test(`preserves partial compaction settings ${JSON.stringify(compaction)}`, () => {
			writeConfig({ compaction });
			expect(loadAgentSettings(path)).toEqual({ contextWindow: undefined, settings: { compaction } });
		});
	}

	test("accepts positive context windows and safe integer upper bounds", () => {
		for (const contextWindow of [1, Number.MAX_SAFE_INTEGER]) {
			writeConfig({
				contextWindow,
				compaction: { reserveTokens: 0, keepRecentTokens: Number.MAX_SAFE_INTEGER },
			});
			expect(loadAgentSettings(path)).toEqual({
				contextWindow,
				settings: { compaction: { reserveTokens: 0, keepRecentTokens: Number.MAX_SAFE_INTEGER } },
			});
		}
	});

	for (const field of ["reserveTokens", "keepRecentTokens"]) {
		test(`accepts the safe integer upper bound for compaction.${field}`, () => {
			writeConfig({ compaction: { [field]: Number.MAX_SAFE_INTEGER } });
			expect(loadAgentSettings(path).settings.compaction).toEqual({ [field]: Number.MAX_SAFE_INTEGER });
		});
	}

	test("rejects numbers that overflow while parsing JSON", () => {
		writeFileSync(path, '{"contextWindow": 1e999, "compaction": {"reserveTokens": 1e999}}');
		expect(() => loadAgentSettings(path)).toThrow("/contextWindow:");
		expect(() => loadAgentSettings(path)).toThrow("/compaction/reserveTokens:");
	});

	test("reloads the file and returns independent settings objects", () => {
		writeConfig({ compaction: { reserveTokens: 1 } });
		const first = loadAgentSettings(path);
		first.settings.compaction!.reserveTokens = 2;
		expect(loadAgentSettings(path).settings.compaction!.reserveTokens).toBe(1);
		writeConfig({ contextWindow: 100 });
		expect(loadAgentSettings(path)).toEqual({ contextWindow: 100, settings: {} });
	});

	for (const value of [null, [], "settings", true, 42]) {
		test(`rejects a non-object config ${JSON.stringify(value)}`, () => {
			expectInvalid(value, "/: expected object");
		});
	}

	for (const value of ["272000", null, false, [], {}, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		test(`rejects contextWindow=${JSON.stringify(value)} without coercion`, () => {
			expectInvalid({ contextWindow: value }, "/contextWindow:");
		});
	}

	for (const value of [null, [], "settings", true, 42]) {
		test(`rejects a non-object compaction ${JSON.stringify(value)}`, () => {
			expectInvalid({ compaction: value }, "/compaction:");
		});
	}

	for (const field of ["reserveTokens", "keepRecentTokens"]) {
		for (const value of ["20000", null, false, [], {}, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
			test(`rejects compaction.${field}=${JSON.stringify(value)} without coercion`, () => {
				expectInvalid({ compaction: { [field]: value } }, `/compaction/${field}:`);
			});
		}
	}

	test("rejects unknown top-level fields", () => {
		expectInvalid({ contextWidnow: 100 }, "/contextWidnow: unknown field");
	});

	test("rejects unknown compaction fields", () => {
		expectInvalid({ compaction: { reserveToken: 1 } }, "/compaction/reserveToken: unknown field");
	});

	test("reports every invalid field with its JSON Pointer path without echoing values", () => {
		writeConfig({ contextWindow: "private-value", compaction: { reserveTokens: -1, keepRecentTokens: null } });
		let message = "";
		try {
			loadAgentSettings(path);
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}
		expect(message).toContain(path);
		expect(message).toContain("/contextWindow:");
		expect(message).toContain("/compaction/reserveTokens:");
		expect(message).toContain("/compaction/keepRecentTokens:");
		expect(message).not.toContain("private-value");
	});

	for (const content of ["", '{"contextWindow":', '{"private-key": "do-not-print-this", invalid}']) {
		test(`reports invalid JSON without exposing file contents (${content.length} characters)`, () => {
			writeFileSync(path, content);
			expect(() => loadAgentSettings(path)).toThrow(`Invalid agent settings ${path}: invalid JSON`);
			expect(() => loadAgentSettings(path)).not.toThrow("do-not-print-this");
		});
	}

	test("reports missing files instead of silently using defaults", () => {
		expect(() => loadAgentSettings(path)).toThrow(path);
		expect(() => loadAgentSettings(path)).toThrow("ENOENT");
	});

	test("reports file read errors with their path and reason", () => {
		expect(() => loadAgentSettings(workspace)).toThrow(workspace);
		expect(() => loadAgentSettings(workspace)).toThrow("EISDIR");
	});
});
