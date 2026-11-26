# Progress tracker reference

This reference covers `pi-bot-core/progress` (subpath-only). `ProgressTracker` is a platform-independent state and rendering module with no SDK imports, no platform imports, and no I/O. For SDK event wiring, see [Integrate a bot](integrate-a-bot.md#track-tool-progress-during-a-run).

## API

Create one `ProgressTracker` per bot run and discard it when the run finishes. The module has no singleton, timer, clock, cancellation inference, or session lifecycle. The application owns SDK subscriptions, logging, message delivery and edits, throttling, cancellation controls, and shutdown.

- `new ProgressTracker()` creates isolated run state.
- `tracker.apply(event: ProgressEvent): void` consumes a normalized event synchronously.
- `tracker.render(formatText?: (text: string) => string): string` returns plain-text progress without mutating state. The empty state renders `"Working…"`.

### `ProgressEvent`

| `type` | Required fields | Optional fields |
| --- | --- | --- |
| `"tool_start"` | `toolCallId`, `toolName` | `parentToolCallId`, `label` |
| `"tool_end"` | `toolCallId`, `toolName`, `isError` | `parentToolCallId`, `durationMs` |
| `"compaction"` | None | None |
| `"retry"` | `attempt`, `max` | None |

### Example

```ts
import { ProgressTracker, type ProgressEvent } from "pi-bot-core/progress";

const progress = new ProgressTracker();
const events: ProgressEvent[] = [
	{ type: "tool_start", toolName: "codemode", toolCallId: "call-1" },
	{ type: "tool_start", toolName: "bash", toolCallId: "call-2", parentToolCallId: "call-1", label: "Check dependencies" },
	{ type: "tool_start", toolName: "bash", toolCallId: "call-3", parentToolCallId: "call-1", label: "Run tests" },
	{ type: "tool_start", toolName: "bash", toolCallId: "call-4", parentToolCallId: "call-1", label: "Build project" },
	{ type: "tool_end", toolName: "bash", toolCallId: "call-3", parentToolCallId: "call-1", isError: false, durationMs: 34100 },
	{ type: "tool_end", toolName: "bash", toolCallId: "call-4", parentToolCallId: "call-1", isError: false, durationMs: 44900 },
];
for (const event of events) progress.apply(event);
const body = progress.render();
```

Rendered output:

```text
codemode
… bash — Check dependencies
✓ bash — Run tests 34.1s
✓ bash — Build project 44.9s
```

## Event correlation and parent rules

Event tracking follows these identity and parent resolution rules:

- Forward `tool_start` before `tool_end` for each call. Start identity and `parentToolCallId` are authoritative. End events correlate by `toolCallId`.
- `toolCallId` values are opaque and must be unique within a run. Different IDs never merge, even when both `toolName` and normalized `label` are identical.
- An end event with an unknown `toolCallId` is ignored.
- The first end event for a call is terminal. Later end events cannot overwrite a failure, replace its duration, or refresh its revision.
- Duplicate start events are ignored, including after a completed call leaves the display.
- Only the exact `toolName` value `"codemode"` creates a wrapper. Parent relationships come exclusively from `parentToolCallId`, never from labels, ID prefixes, or whichever wrapper is active.
- Ancestor chains resolve through native calls as well. Unknown parent IDs do not create synthetic headings. If a real parent start arrives later, it associates with retained children.

## Rendering rules

Rendering produces plain text, not a Markdown code block. Client fonts and line wrapping determine visual layout, so three status rows may wrap across more than three visual lines.

### Status icons and row limit

Status rows follow these icon and eviction rules:

- Status icons are `…` (U+2026) for running, `✓` for success, and `✗` for error. There is no animation, clock, timer, or inferred elapsed time.
- Output keeps at most the three most recently revised status rows across tool calls, Codemode fallback and failure rows, and compaction and retry notices.
- Completing a visible call refreshes its recency without changing its position.
- Completing a hidden active call appends it to the visible rows and evicts the least recently revised row.
- Duplicate events do not refresh recency.

### Codemode headings and wrapper rows

Codemode wrappers follow these heading and status rules:

- Headings render as unadorned `codemode` lines, left-aligned alongside status rows, and do not count toward the three-row limit.
- Only headings required by visible rows appear. Heading identity is the parent `toolCallId`, not the heading text, so concurrent wrappers stay distinct.
- Rows are never reordered or regrouped for presentation. Interleaved parents or direct tool calls between children can repeat headings.
- Before its first child starts, a Codemode wrapper renders `codemode` followed by `… Script`. A wrapper that finishes cleanly with no children becomes `✓ Script` (with `durationMs` when provided).
- The first child replaces the fallback `Script` row. Once a wrapper has children, parent success adds no row and does not refresh children. A heading does not imply that the wrapper has finished.
- Any parent error inserts or updates `✗ Script failed`, whether or not children ran or succeeded. Late child events do not remove this row, and duplicate parent success cannot erase it. It displays the wrapper's own `durationMs` when supplied, never the sum of child durations, and ages out under the standard three-row limit.

### Duration formatting

Duration formatting follows these rules:

- Completed tool rows display only the SDK `durationMs`. Running rows never show a duration, and concurrent durations are never summed.
- Values below `1000` (compared before rounding) render in rounded milliseconds, such as `0ms`, `13ms`, and `999ms`. Because the threshold uses the unrounded value, `999.6` renders `1000ms`.
- Values at or above `1000` render in one-decimal seconds (`1.0s`, `34.1s`).
- `undefined` omits the duration. `0` renders `0ms`. Preserve absent durations rather than substituting `0`.

### Titles, truncation, and notices

Text normalization and notice formatting follow these rules:

- Tool names and labels have whitespace collapsed and trimmed, and C0 and C1 control characters removed.
- An empty normalized tool name displays `tool`. Absent, blank, or equal-to-name labels are omitted. Wrapper labels are never rendered.
- Combined `toolName — label` titles have a 120-Unicode-code-point budget and end in `…` when truncated without splitting surrogate pairs. The tool name has priority. If no room remains for ` — ` plus at least one code point, the label is omitted. Status icons and durations sit outside this budget.
- Direct tools outside Codemode render normally, such as `… read` or `✓ bash — Check CI 120ms`.
- Compaction renders `… Compacting context`. Retry renders `… Retrying (<attempt>/<max>)`. Each notice event is a new revision. There are no notice-end events.

## Escaping and label safety

Pass a `formatText` callback to `render()` when posting into Markdown-enabled channels:

- `formatText` receives each normalized, truncated text fragment, including both tool names and labels, before `ProgressTracker` adds icons, separators, and durations.
- `formatText` must preserve single-line boundaries and never mutates stored tracker state.
- `ProgressTracker` never reads tool arguments, code, outputs, errors, or stacks. Supply only caller-approved purpose text in `label`. Never derive labels from commands, script source, tool outputs, or error messages.

## Memory retention

Completed call payloads remain in memory only while they occupy a visible row or serve as an ancestor of a visible or active call. Hidden active calls keep their metadata until their end event arrives. Identity-only tombstones (`Set<string>` of seen `toolCallId` values) persist for the lifetime of the tracker so late duplicate starts cannot resurrect evicted calls. Memory for tombstones grows as O(unique call IDs) per run, so discard the tracker when the run ends.
