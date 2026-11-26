import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Cron } from "croner";
import { randomBytes } from "crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { compile, obj, oneOf, opt, str, type Schema, type Static } from "@earendil-works/pi-schema";

const scheduleEventType = oneOf(["immediate", "one-shot", "periodic"]);
export type ScheduleEventType = Static<typeof scheduleEventType>;

/**
 * Platform-agnostic fields every scheduled event carries.
 *
 * Each bot composes its own pi-schema parameters schema (chatId/channelId,
 * threadId, etc.) and projects validated args onto this shape via
 * {@link CreateScheduleToolConfig.buildRouting} + the common fields below.
 */
const commonScheduleSchema = obj({
	label: str(),
	type: scheduleEventType,
	text: str(),
	at: opt(str()),
	schedule: opt(str()),
	timezone: opt(str()),
	name: opt(str()),
}, { open: true });

export type CommonScheduleArgs = Static<typeof commonScheduleSchema>;

const commonSchedule = compile(commonScheduleSchema);

type ScheduleTiming =
	| { type: "immediate" }
	| { type: "one-shot"; at: string }
	| { type: "periodic"; schedule: string; timezone: string };

type ScheduledEventPayload = ScheduleTiming & { text: string } & Record<string, unknown>;

const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const RESERVED_ROUTING_FIELDS = ["type", "text", "at", "schedule", "timezone"];

/**
 * Build an event JSON payload + filename from validated common fields plus
 * per-platform routing fields (e.g. `{ channelId }` or `{ chatId, threadId? }`)
 * merged into the output JSON without overriding event fields.
 */
export function buildEventPayload(
	args: CommonScheduleArgs & { routing: Record<string, unknown> },
	now: number = Date.now(),
): { filename: string; json: ScheduledEventPayload } {
	const timing = parseScheduleTiming(args, now);
	const slug = args.name ?? timing.type;
	if (!SLUG_RE.test(slug)) {
		throw new Error(`schedule_event: 'name' must match /^[a-z0-9-]{1,40}$/, got: ${slug}`);
	}
	for (const field of RESERVED_ROUTING_FIELDS) {
		if (Object.hasOwn(args.routing, field)) throw new Error(`schedule_event: reserved routing field '${field}'`);
	}
	return {
		filename: `${slug}-${now}.json`,
		json: { ...args.routing, ...timing, text: args.text },
	};
}

function parseScheduleTiming({ type, at, schedule, timezone }: CommonScheduleArgs, now: number): ScheduleTiming {
	switch (type) {
		case "one-shot": {
			if (!at) throw new Error("schedule_event: 'at' is required for type='one-shot'");
			const ms = Date.parse(at);
			if (Number.isNaN(ms)) throw new Error(`schedule_event: 'at' is not a valid ISO 8601 timestamp: ${at}`);
			if (ms <= now) throw new Error(`schedule_event: 'at' must be in the future: ${at}`);
			if (schedule || timezone) {
				throw new Error("schedule_event: 'schedule'/'timezone' are only for type='periodic'");
			}
			return { type, at };
		}
		case "periodic": {
			if (!schedule) throw new Error("schedule_event: 'schedule' is required for type='periodic'");
			if (!timezone) throw new Error("schedule_event: 'timezone' is required for type='periodic'");
			if (at) throw new Error("schedule_event: 'at' is only for type='one-shot'");
			try {
				// Some runtimes accept UTC offsets here, but the tool requires an IANA name.
				const canonicalZone = new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone;
				if (/^[+-]/.test(canonicalZone)) throw new Error("Use an IANA timezone name, not a UTC offset");
				const cron = new Cron(schedule, { timezone });
				if (cron.getOnce()) throw new Error("Use a recurring cron pattern, not a one-shot date");
				if (!cron.nextRun(new Date(now))) throw new Error("No future occurrence");
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`schedule_event: invalid 'schedule' or 'timezone': ${reason}`);
			}
			return { type, schedule, timezone };
		}
		case "immediate":
			if (at || schedule || timezone) {
				throw new Error("schedule_event: type='immediate' takes no 'at'/'schedule'/'timezone'");
			}
			return { type };
		default: {
			const _exhaustive: never = type;
			throw new Error(`schedule_event: unsupported type ${_exhaustive}`);
		}
	}
}

export interface CreateScheduleToolConfig<TParams extends Schema> {
	workspace: string;
	/** JSON Schema for the tool's `parameters`, typed with pi-schema. */
	parameters: TParams;
	/** Description shown to the LLM. */
	description: string;
	/**
	 * Project validated args onto routing fields merged verbatim into the
	 * persisted JSON (e.g. `{ channelId: args.channelId }` or
	 * `{ chatId: args.chatId, threadId: args.threadId }`).
	 */
	buildRouting: (args: Static<TParams>) => Record<string, unknown>;
}

/**
 * Create a `schedule_event` tool that writes a validated event JSON file
 * under `${workspace}/events/`. The host EventsWatcher picks it up and
 * schedules it.
 *
 * Why a tool instead of letting the agent `cat > foo.json << EOF`:
 * the bash + write-tool path has no schema gate, so the LLM frequently ad-libs
 * field names. parseEvent rejects + auto-deletes the file, the LLM gets a
 * "wrote N bytes" success from the write tool, and the bug stays silent.
 * This tool puts the schema at the call site so wrong calls fail loudly,
 * with the error visible to the LLM.
 */
export function createScheduleTool<TParams extends Schema>(
	config: CreateScheduleToolConfig<TParams>,
): AgentTool<TParams> {
	const eventsDir = join(config.workspace, "events");
	return {
		name: "schedule_event",
		label: "schedule_event",
		description: config.description,
		parameters: config.parameters,
		execute: async (_toolCallId, args, signal) => {
			signal?.throwIfAborted();

			if (!commonSchedule.check(args)) {
				const issues = commonSchedule.errors(args).map(({ path, message }) => `${path || "/"}: ${message}`);
				throw new Error(`schedule_event: invalid arguments: ${issues.join("; ")}`);
			}
			const { filename, json } = buildEventPayload({
				...args,
				routing: config.buildRouting(args),
			});

			mkdirSync(eventsDir, { recursive: true });
			const fullPath = join(eventsDir, filename);
			// Keep the temporary name shorter than any event name; the watcher ignores .tmp files.
			const tempPath = join(eventsDir, `${randomBytes(6).toString("hex")}.tmp`);
			const fd = openSync(tempPath, "wx");
			try {
				try {
					writeFileSync(fd, JSON.stringify(json, null, 2), { encoding: "utf-8" });
				} finally {
					closeSync(fd);
				}
				renameSync(tempPath, fullPath);
			} finally {
				rmSync(tempPath, { force: true });
			}

			const summary =
				json.type === "one-shot"
					? `at ${json.at}`
					: json.type === "periodic"
						? `${json.schedule} (${json.timezone})`
						: "immediate";

			return {
				content: [
					{
						type: "text",
						text: `Scheduled ${json.type} event: ${filename} (${summary})`,
					},
				],
				details: { filename, path: fullPath, type: json.type },
			};
		},
	};
}
