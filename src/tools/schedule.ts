import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Cron } from "croner";
import { randomBytes } from "crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { compile, nullable, obj, oneOf, opt, str, type Schema, type Static } from "@earendil-works/pi-schema";

const scheduleEventType = oneOf(["immediate", "one-shot", "periodic"]);
export type ScheduleEventType = Static<typeof scheduleEventType>;

const optionalScheduleText = opt(nullable(str()));
const scheduleFieldsSchema = obj({
	type: scheduleEventType,
	text: str(),
	at: optionalScheduleText,
	schedule: optionalScheduleText,
	timezone: optionalScheduleText,
	name: optionalScheduleText,
}, { open: true });

type ScheduleFields = Static<typeof scheduleFieldsSchema>;
type DirectScheduleFields = { [Key in keyof ScheduleFields]: Exclude<ScheduleFields[Key], null> };

/** Platform-agnostic arguments for building an event payload directly. */
export interface CommonScheduleArgs extends DirectScheduleFields {
	label: string;
}

const scheduleFields = compile(scheduleFieldsSchema);

/** When an event fires. Each `type` carries exactly the fields it needs. */
export type ScheduleTiming =
	| { type: "immediate" }
	| {
		type: "one-shot";
		/** ISO 8601. */
		at: string;
	}
	| {
		type: "periodic";
		/** Cron syntax. */
		schedule: string;
		/** IANA timezone. */
		timezone: string;
	};

const SLUG_RE = /^[a-z0-9-]{1,40}$/;

/**
 * Build an event JSON payload + filename from validated common fields plus
 * per-platform routing fields (e.g. `{ channelId }` or `{ chatId, threadId? }`)
 * merged into the output JSON.
 */
export function buildEventPayload(
	args: CommonScheduleArgs & { routing: Record<string, unknown> },
	now: number = Date.now(),
): { filename: string; json: Record<string, unknown> } {
	const { filename, json } = composeSchedule(args, now);
	return { filename, json };
}

function composeSchedule(args: ScheduleFields & { routing: Record<string, unknown> }, now: number) {
	const timing = parseScheduleTiming(args, now);
	const slug = args.name ?? timing.type;
	if (!SLUG_RE.test(slug)) {
		throw new Error(`schedule_event: 'name' must match /^[a-z0-9-]{1,40}$/, got: ${slug}`);
	}
	return {
		filename: `${slug}-${now}.json`,
		// Validated type, text, and timing fields win over routing.
		json: { ...args.routing, ...timing, text: args.text },
		timing,
	};
}

function parseScheduleTiming({ type, at, schedule, timezone }: ScheduleFields, now: number): ScheduleTiming {
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

			if (!scheduleFields.check(args)) {
				const issues = scheduleFields.errors(args).map(({ path, message }) => `${path || "/"}: ${message}`);
				throw new Error(`schedule_event: invalid arguments: ${issues.join("; ")}`);
			}
			const { filename, json, timing } = composeSchedule({
				...args,
				routing: config.buildRouting(args),
			}, Date.now());

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
				timing.type === "one-shot"
					? `at ${timing.at}`
					: timing.type === "periodic"
						? `${timing.schedule} (${timing.timezone})`
						: "immediate";

			return {
				content: [
					{
						type: "text",
						text: `Scheduled ${timing.type} event: ${filename} (${summary})`,
					},
				],
				details: { filename, path: fullPath, type: timing.type },
			};
		},
	};
}
