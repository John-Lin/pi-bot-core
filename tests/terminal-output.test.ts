import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["logger", "events watcher"])("%s can finish after the stdout pipe closes", (source) => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-bot-terminal-output-"));
	try {
		const closed = join(workspace, "pipe-closed");
		const action = source === "logger"
			? `const { createLogger } = await import(${JSON.stringify(import.meta.resolve("pi-bot-core/log"))});
				createLogger({ formatContext: () => "test" }).logInfo("after stdout closed");`
			: `const { EventsWatcher } = await import(${JSON.stringify(import.meta.resolve("pi-bot-core/events"))});
				const watcher = new EventsWatcher(${JSON.stringify(workspace)}, async () => {}, {
					parse: JSON.parse, queueKey: () => "test",
				});
				watcher.start();
				watcher.stop();`;
		const probe = `
			process.stdout.write("ready\\n");
			while (!(await Bun.file(${JSON.stringify(closed)}).exists())) await Bun.sleep(5);
			${action}
			process.stderr.write("finished\\n");
		`;
		// Close the pipe in both the reader and its shell before unblocking the writer.
		const result = Bun.spawnSync([
			"/bin/bash", "-o", "pipefail", "-c", '"$1" --no-env-file -e "$2" | { head -n 1; exec 0<&-; : > "$3"; }',
			"terminal-output-test", process.execPath, probe, closed,
		], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000 });

		expect(result.stdout.toString(), result.stderr.toString()).toBe("ready\n");
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(result.stderr.toString()).toBe("finished\n");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
