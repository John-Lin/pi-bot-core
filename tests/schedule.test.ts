import { describe, expect, test } from "bun:test";
import { buildEventPayload } from "../src/tools/schedule.js";

const NOW = Date.parse("2026-04-26T00:00:00+08:00");
const FUTURE = "2026-12-14T09:00:00+08:00";

describe("buildEventPayload", () => {
	test("immediate: minimal", () => {
		const { filename, json } = buildEventPayload(
			{ label: "x", type: "immediate", text: "hi", routing: { chatId: 123 } },
			NOW,
		);
		expect(filename).toBe(`immediate-${NOW}.json`);
		expect(json).toEqual({ type: "immediate", chatId: 123, text: "hi" });
	});

	test("immediate: routing fields are merged verbatim (incl. extras like threadId)", () => {
		const { json } = buildEventPayload(
			{ label: "x", type: "immediate", text: "hi", routing: { chatId: 1, threadId: 42 } },
			NOW,
		);
		expect(json.threadId).toBe(42);
	});

	test("keeps routing extras and the established precedence of message and schedule fields", () => {
		const { filename, json } = buildEventPayload({
			label: "x", type: "one-shot", text: "hi", at: FUTURE,
			routing: { chatId: 1, text: "routing text", at: "routing timestamp", timezone: "UTC" },
		}, NOW);
		expect(filename).toBe(`one-shot-${NOW}.json`);
		expect(json).toEqual({ type: "one-shot", chatId: 1, text: "hi", at: FUTURE, timezone: "UTC" });
	});

	test("immediate: rejects 'at'", () => {
		expect(() =>
			buildEventPayload(
				{ label: "x", type: "immediate", text: "hi", at: FUTURE, routing: { chatId: 1 } },
				NOW,
			),
		).toThrow(/no 'at'/);
	});

	test("one-shot: full valid", () => {
		const { json } = buildEventPayload(
			{ label: "x", type: "one-shot", text: "hi", at: FUTURE, routing: { channelId: "1" } },
			NOW,
		);
		expect(json).toEqual({ type: "one-shot", channelId: "1", text: "hi", at: FUTURE });
	});

	test("one-shot: missing 'at' rejected", () => {
		expect(() =>
			buildEventPayload({ label: "x", type: "one-shot", text: "hi", routing: { chatId: 1 } }, NOW),
		).toThrow(/'at' is required/);
	});

	test("one-shot: past 'at' rejected", () => {
		expect(() =>
			buildEventPayload(
				{
					label: "x",
					type: "one-shot",
					text: "hi",
					at: "2020-01-01T00:00:00+00:00",
					routing: { chatId: 1 },
				},
				NOW,
			),
		).toThrow(/must be in the future/);
	});

	test("one-shot: invalid 'at' rejected", () => {
		expect(() =>
			buildEventPayload(
				{ label: "x", type: "one-shot", text: "hi", at: "not-a-date", routing: { chatId: 1 } },
				NOW,
			),
		).toThrow(/not a valid ISO/);
	});

	test("periodic: full valid", () => {
		const { json } = buildEventPayload(
			{
				label: "x",
				type: "periodic",
				text: "hi",
				schedule: "0 9 * * 1-5",
				timezone: "Asia/Taipei",
				routing: { chatId: 1 },
			},
			NOW,
		);
		expect(json).toEqual({
			type: "periodic",
			chatId: 1,
			text: "hi",
			schedule: "0 9 * * 1-5",
			timezone: "Asia/Taipei",
		});
	});

	for (const [schedule, timezone] of [
		["not a cron expression", "Asia/Taipei"],
		["0 9 * * *", "Mars/Olympus"],
		["0 9 31 2 *", "Asia/Taipei"],
		["2099-02-30T00:00:00Z", "UTC"],
		["2099-03-01T00:00:00Z", "Asia/Taipei"],
		["0 9 * * *", "+08:00"],
		["0 9 * * *", "-05:00"],
		["0 9 * * *", "−05:00"],
		["0 9 * * *", "−0500"],
		["0 9 * * *", "−05"],
	] as const) {
		test(`periodic: rejects an invalid recurring schedule or timezone (${schedule}, ${timezone})`, () => {
			expect(() =>
				buildEventPayload(
					{ label: "x", type: "periodic", text: "hi", schedule, timezone, routing: { chatId: 1 } },
					NOW,
				),
			).toThrow(/invalid 'schedule' or 'timezone'/);
		});
	}

	for (const timezone of ["UTC", "Asia/Taipei", "Etc/GMT+8"]) {
		test(`periodic: keeps recurring macros and IANA timezone ${timezone}`, () => {
			const { json } = buildEventPayload(
				{ label: "x", type: "periodic", text: "hi", schedule: "@daily", timezone, routing: { chatId: 1 } },
				NOW,
			);
			expect(json.schedule).toBe("@daily");
			expect(json.timezone).toBe(timezone);
		});
	}

	test("periodic: missing schedule rejected", () => {
		expect(() =>
			buildEventPayload(
				{
					label: "x",
					type: "periodic",
					text: "hi",
					timezone: "Asia/Taipei",
					routing: { chatId: 1 },
				},
				NOW,
			),
		).toThrow(/'schedule' is required/);
	});

	test("periodic: missing timezone rejected", () => {
		expect(() =>
			buildEventPayload(
				{
					label: "x",
					type: "periodic",
					text: "hi",
					schedule: "0 9 * * *",
					routing: { chatId: 1 },
				},
				NOW,
			),
		).toThrow(/'timezone' is required/);
	});

	test("periodic: 'at' rejected", () => {
		expect(() =>
			buildEventPayload(
				{
					label: "x",
					type: "periodic",
					text: "hi",
					schedule: "0 9 * * *",
					timezone: "Asia/Taipei",
					at: FUTURE,
					routing: { chatId: 1 },
				},
				NOW,
			),
		).toThrow(/only for type='one-shot'/);
	});

	test("custom name slug used in filename", () => {
		const { filename } = buildEventPayload(
			{
				label: "x",
				type: "one-shot",
				text: "hi",
				at: FUTURE,
				name: "remind-dinner",
				routing: { chatId: 1 },
			},
			NOW,
		);
		expect(filename).toBe(`remind-dinner-${NOW}.json`);
	});

	test("invalid name slug rejected", () => {
		expect(() =>
			buildEventPayload(
				{
					label: "x",
					type: "immediate",
					text: "hi",
					name: "Bad Name!",
					routing: { chatId: 1 },
				},
				NOW,
			),
		).toThrow(/'name' must match/);
	});
});
