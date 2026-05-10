import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Static, TSchema } from "typebox";

export type ScheduleEventType = "immediate" | "one-shot" | "periodic";

/**
 * Platform-agnostic fields every scheduled event carries.
 *
 * Each bot composes its own typebox parameters schema (chatId/channelId,
 * threadId, etc.) and projects validated args onto this shape via
 * {@link CreateScheduleToolConfig.buildRouting} + the common fields below.
 */
export interface CommonScheduleArgs {
	label: string;
	type: ScheduleEventType;
	text: string;
	at?: string;
	schedule?: string;
	timezone?: string;
	name?: string;
}

const SLUG_RE = /^[a-z0-9-]{1,40}$/;

/**
 * Build an event JSON payload + filename from validated common fields plus
 * per-platform routing fields (e.g. `{ channelId }` or `{ chatId, threadId? }`)
 * merged verbatim into the output JSON.
 */
export function buildEventPayload(
	args: CommonScheduleArgs & { routing: Record<string, unknown> },
	now: number = Date.now(),
): { filename: string; json: Record<string, unknown> } {
	if (args.type === "one-shot") {
		if (!args.at) throw new Error("schedule_event: 'at' is required for type='one-shot'");
		const ms = Date.parse(args.at);
		if (Number.isNaN(ms)) {
			throw new Error(`schedule_event: 'at' is not a valid ISO 8601 timestamp: ${args.at}`);
		}
		if (ms <= now) {
			throw new Error(`schedule_event: 'at' must be in the future: ${args.at}`);
		}
		if (args.schedule || args.timezone) {
			throw new Error("schedule_event: 'schedule'/'timezone' are only for type='periodic'");
		}
	} else if (args.type === "periodic") {
		if (!args.schedule) {
			throw new Error("schedule_event: 'schedule' is required for type='periodic'");
		}
		if (!args.timezone) {
			throw new Error("schedule_event: 'timezone' is required for type='periodic'");
		}
		if (args.at) {
			throw new Error("schedule_event: 'at' is only for type='one-shot'");
		}
	} else {
		// immediate
		if (args.at || args.schedule || args.timezone) {
			throw new Error("schedule_event: type='immediate' takes no 'at'/'schedule'/'timezone'");
		}
	}

	const slug = args.name ?? args.type;
	if (!SLUG_RE.test(slug)) {
		throw new Error(`schedule_event: 'name' must match /^[a-z0-9-]{1,40}$/, got: ${slug}`);
	}

	const filename = `${slug}-${now}.json`;

	const json: Record<string, unknown> = {
		type: args.type,
		...args.routing,
		text: args.text,
	};
	if (args.type === "one-shot") json.at = args.at;
	if (args.type === "periodic") {
		json.schedule = args.schedule;
		json.timezone = args.timezone;
	}

	return { filename, json };
}

export interface CreateScheduleToolConfig<TParams extends TSchema> {
	workspace: string;
	/** Typebox schema for the tool's `parameters`. */
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
export function createScheduleTool<TParams extends TSchema>(
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

			const common = args as CommonScheduleArgs;
			const { filename, json } = buildEventPayload({
				...common,
				routing: config.buildRouting(args),
			});

			mkdirSync(eventsDir, { recursive: true });
			const fullPath = join(eventsDir, filename);
			writeFileSync(fullPath, JSON.stringify(json, null, 2), { encoding: "utf-8" });

			const summary =
				common.type === "one-shot"
					? `at ${common.at}`
					: common.type === "periodic"
						? `${common.schedule} (${common.timezone})`
						: "immediate";

			return {
				content: [
					{
						type: "text",
						text: `Scheduled ${common.type} event: ${filename} (${summary})`,
					},
				],
				details: { filename, path: fullPath, type: common.type },
			};
		},
	};
}
