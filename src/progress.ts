interface ToolIdentity {
	toolCallId: string;
	toolName: string;
	parentToolCallId?: string;
}

/** Bot-owned projection of SDK events. Labels must be safe, human-readable purposes, not arguments. */
export type ProgressEvent =
	| (ToolIdentity & { type: "tool_start"; label?: string })
	| (ToolIdentity & { type: "tool_end"; isError: boolean; durationMs?: number })
	| { type: "compaction" }
	| { type: "retry"; attempt: number; max: number };

type ToolStatus =
	| { kind: "running" }
	| { kind: "finished"; isError: boolean; durationMs?: number };

interface ToolProgress {
	kind: "tool";
	id: string;
	toolName: string;
	label?: string;
	parentToolCallId?: string;
	isCodemode: boolean;
	hasChildren: boolean;
	status: ToolStatus;
	revision: number;
}

interface NoticeProgress {
	kind: "notice";
	label: string;
	revision: number;
}

type Line = ToolProgress | NoticeProgress;
const MAX_PROGRESS_LINES = 3;
const MAX_PROGRESS_TITLE_LENGTH = 120;

/** One tracker per run. Owns no clocks, subscriptions, transport, logging or cancellation. */
export class ProgressTracker {
	private calls = new Map<string, ToolProgress>();
	// Identity-only tombstones make duplicate delivery idempotent even after payload eviction.
	private seenToolCallIds = new Set<string>();
	private lines: Line[] = [];
	private revision = 0;

	apply(event: ProgressEvent): void {
		switch (event.type) {
			case "tool_start": {
				if (this.seenToolCallIds.has(event.toolCallId)) return;
				const call: ToolProgress = {
					kind: "tool",
					id: event.toolCallId,
					...toolTitle(event.toolName, event.label),
					parentToolCallId: event.parentToolCallId,
					isCodemode: event.toolName === "codemode",
					hasChildren: [...this.calls.values()].some((child) => child.parentToolCallId === event.toolCallId),
					status: { kind: "running" },
					revision: 0,
				};
				this.calls.set(call.id, call);
				this.seenToolCallIds.add(call.id);
				const parent = event.parentToolCallId === undefined ? undefined : this.calls.get(event.parentToolCallId);
				if (parent) {
					parent.hasChildren = true;
					if (parent.isCodemode && !(parent.status.kind === "finished" && parent.status.isError)) {
						this.lines = this.lines.filter((line) => line !== parent);
					}
				}
				if (!call.isCodemode || !call.hasChildren) this.updateLine(call);
				break;
			}
			case "tool_end": {
				const call = this.calls.get(event.toolCallId);
				if (!call || call.status.kind !== "running") return;
				call.status = { kind: "finished", isError: event.isError, durationMs: event.durationMs };
				// A heading cannot communicate script failure, even if every child succeeded.
				if (!call.isCodemode || !call.hasChildren || event.isError) this.updateLine(call);
				break;
			}
			case "compaction":
				this.updateLine({ kind: "notice", label: "Compacting context", revision: 0 });
				break;
			case "retry":
				this.updateLine({ kind: "notice", label: `Retrying (${event.attempt}/${event.max})`, revision: 0 });
				break;
			default: {
				const _exhaustive: never = event;
				return _exhaustive;
			}
		}
		this.pruneCalls();
	}

	/** Escape text fragments at presentation time (e.g. Discord's escapeMarkdown), after truncation. */
	render(formatText: (text: string) => string = (text) => text): string {
		if (this.lines.length === 0) return "Working…";
		const rendered: string[] = [];
		let previous: ToolProgress[] = [];
		for (const line of this.lines) {
			const headings = line.kind === "tool" ? this.headings(line) : [];
			let shared = 0;
			while (shared < headings.length && headings[shared]?.id === previous[shared]?.id) shared++;
			for (let index = shared; index < headings.length; index++) {
				rendered.push(formatText("codemode"));
			}
			const completed = line.kind === "tool" && line.status.kind === "finished" ? line.status : undefined;
			let title: string;
			if (line.kind === "notice") {
				title = formatText(line.label);
			} else if (line.isCodemode) {
				title = formatText(completed?.isError ? "Script failed" : "Script");
			} else {
				title = formatText(line.toolName);
				if (line.label) title += ` — ${formatText(line.label)}`;
			}
			const icon = completed === undefined ? "…" : completed.isError ? "✗" : "✓";
			const duration = completed?.durationMs === undefined ? "" : ` ${formatDuration(completed.durationMs)}`;
			rendered.push(`${icon} ${title}${duration}`);
			previous = headings;
		}
		return rendered.join("\n");
	}

	private updateLine(line: Line): void {
		line.revision = ++this.revision;
		if (!this.lines.includes(line)) this.lines.push(line);
		if (this.lines.length <= MAX_PROGRESS_LINES) return;
		const oldest = this.lines.reduce((oldest, entry) => entry.revision < oldest.revision ? entry : oldest, line);
		this.lines = this.lines.filter((entry) => entry !== oldest);
	}

	private headings(call: ToolProgress): ToolProgress[] {
		const headings: ToolProgress[] = [];
		const visited = new Set<string>();
		let current: ToolProgress | undefined = call;
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			if (current.isCodemode) headings.unshift(current);
			current = current.parentToolCallId === undefined ? undefined : this.calls.get(current.parentToolCallId);
		}
		return headings;
	}

	private pruneCalls(): void {
		const retained = new Set<string>();
		const retain = (call: ToolProgress) => {
			let current: ToolProgress | undefined = call;
			while (current && !retained.has(current.id)) {
				retained.add(current.id);
				current = current.parentToolCallId === undefined ? undefined : this.calls.get(current.parentToolCallId);
			}
		};
		// Hidden active calls need their ancestor chain when their eventual completion becomes visible.
		for (const call of this.calls.values()) if (call.status.kind === "running") retain(call);
		for (const line of this.lines) if (line.kind === "tool") retain(line);
		for (const id of this.calls.keys()) if (!retained.has(id)) this.calls.delete(id);
	}
}

function normalizeText(text: string): string {
	// oxlint-disable-next-line eslint/no-control-regex -- Strip C0/C1 control characters from untrusted labels before display.
	return text.replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
}

function truncate(text: string, budget: number): string {
	const chars = Array.from(text);
	return chars.length > budget ? `${chars.slice(0, budget - 1).join("")}…` : text;
}

function toolTitle(toolName: string, label?: string): { toolName: string; label?: string } {
	const name = normalizeText(toolName) || "tool";
	const purpose = normalizeText(label ?? "");
	const remaining = MAX_PROGRESS_TITLE_LENGTH - Array.from(name).length - " — ".length;
	return {
		toolName: truncate(name, MAX_PROGRESS_TITLE_LENGTH),
		label: purpose && purpose !== name && remaining > 0 ? truncate(purpose, remaining) : undefined,
	};
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
