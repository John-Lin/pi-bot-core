import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export function firstToolText({ content }: Pick<AgentToolResult<unknown>, "content">): string {
	const item = content[0];
	if (item?.type !== "text") throw new Error("Expected the first tool result to be text");
	return item.text;
}
