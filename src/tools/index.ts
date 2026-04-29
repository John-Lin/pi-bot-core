import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { createBashTool, type BashToolDetails } from "./bash.js";
export { createEditTool, type EditToolDetails } from "./edit.js";
export { createReadTool, type ReadToolDetails } from "./read.js";
export { createWriteTool } from "./write.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "./truncate.js";
export {
	buildEventPayload,
	type CommonScheduleArgs,
	type CreateScheduleToolConfig,
	createScheduleTool,
	type ScheduleEventType,
} from "./schedule.js";

/**
 * Create the default set of tools (read, bash, edit, write) bound to a given Executor.
 * Platform-specific tools (e.g. Slack attach, Discord reply) should be added at the call site.
 */
export function createBotTools(executor: Executor): AgentTool<any>[] {
	return [createReadTool(executor), createBashTool(executor), createEditTool(executor), createWriteTool(executor)];
}
