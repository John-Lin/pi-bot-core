# VM sandbox reference

This reference covers `pi-bot-core/sandbox` (also re-exported from `pi-bot-core`) and `pi-bot-core/vm-sandbox` (subpath-only). For integration steps, see [Integrate a bot](integrate-a-bot.md).

## `pi-bot-core/sandbox`

This module defines the execution contract used by the workspace tools:

- `Executor` is the interface providing `exec(command, options?)`, optional `saveOutput(output, signal?)`, and `getWorkspacePath(hostPath)`.
- `ExecOptions` accepts an optional `timeout` in seconds (no timeout if omitted or less than or equal to 0) and an optional `signal` (`AbortSignal`).
- `ExecResult` has the shape `{ stdout: string; stderr: string; code: number }`.
- `SandboxConfigError` is thrown when sandbox configuration, host dependencies, or cached images are invalid or unavailable.

## `pi-bot-core/vm-sandbox`

This module runs workspace tools inside per-turn Gondolin Linux VMs.

### Constants and types

| Symbol | Definition |
| --- | --- |
| `VM_SANDBOX_IMAGE` | `"alpine-base:0.3.2"` |
| `WORKSPACE_GUEST_ROOT` | `"/workspace"` |
| `VMSandboxBackend` | `"qemu" \| "krun"` (default `"qemu"`) |
| `VMSandboxOptions` | `{ backend?: VMSandboxBackend; secrets?: Readonly<Record<string, SandboxWebSecret>>; writableWorkspaceContent?: boolean }` |
| `SandboxWebSecret` | `{ value?: string; hosts: readonly string[] }` |

### Host requirements

Both backends require macOS or Linux on arm64 or x64 and the following host binaries on `PATH`:

- `qemu-img` for copy-on-write disks (`brew install qemu` on macOS, `qemu-utils` on Debian and Ubuntu).
- `tar` with gzip support (`gzip` must also be on `PATH` when using GNU tar) for cold image downloads.

Backend selection has no automatic fallback. Pass the same `backend` option to `validateVMSandbox` and `new VMSandbox`.

- **QEMU (default).** Put `qemu-system-aarch64` (arm64) or `qemu-system-x86_64` (x64) on `PATH` matching the cached guest image architecture. On macOS, Gondolin uses Hypervisor.framework acceleration for same-architecture guests. On Linux, Gondolin uses KVM when `/dev/kvm` is readable and writable.
- **[krun](https://github.com/earendil-works/gondolin/blob/v0.14.0/docs/backends.md) (experimental).** The QEMU system emulator is not required. Install dependencies with optional dependencies enabled so Gondolin installs its packaged runner with bundled libkrun. The pinned image includes the krun kernel assets.
  - Apple Silicon macOS requires macOS 15 or later and uses Hypervisor.framework.
  - x64 Linux requires glibc 2.36 or later, `libcap-ng.so.0` (`libcap-ng0`), `libgcc_s.so.1` (`libgcc-s1`), and read and write access to `/dev/kvm` for the bot user.

### Startup validation

`validateVMSandbox(options?: Pick<VMSandboxOptions, "backend">): Promise<void>` checks host platform support, verifies `qemu-img`, and pulls `VM_SANDBOX_IMAGE` with a 120-second deadline.

- For `qemu`, it verifies the matching `qemu-system-<arch>` binary.
- For `krun`, it boots and closes a short-lived offline VM (`netEnabled: false`) with a 15-second startup timeout to verify the host hypervisor.

Failures throw `SandboxConfigError`.

### Pool and turn lifecycle

`new VMSandbox(maxConcurrent: number, options?: VMSandboxOptions)` creates a shared pool for one bot process. `maxConcurrent` must be a positive safe integer.

`sandbox.turn(paths: ChatPaths): VMSandboxTurn` prepares a chat-scoped `Executor` for one agent turn:

- Resolves and snapshots all paths in `paths` so later mutations to the caller's object or working directory do not affect the turn.
- Verifies that `chatDir`, `scratchDir`, `attachmentsDir`, `skillsDir`, and `<workspace>/skills` are safe directories, and that `memoryFile` (`MEMORY.md`) is a single-link regular file.
- Does not reserve a pool slot or boot a VM until the first workspace tool call.

During a turn, `VMSandboxTurn` enforces these rules:

- **Lazy boot from cache.** The first tool call acquires a pool slot and boots the VM from the local image cache with a 15-second startup timeout. If the image is missing, the turn throws `SandboxConfigError` instead of downloading it.
- **Output bounds.** `exec()` caps each of `stdout` and `stderr` at 10 MiB. `saveOutput()` writes truncated bash output to `/tmp/pi-bot-bash-<hex>.log` inside the VM.
- **Attachment export.** `readAttachment(path, signal?)` exports a file from `<cwd>/scratch/` or `<cwd>/attachments/` only. It validates the opened descriptor with `openWorkspaceFile` and rejects files larger than 10 MiB. Always export guest files through `turn.readAttachment()` instead of opening guest-supplied paths on the host.
- **Teardown and cleanup failures.** Call `await turn.close()` on turn completion or cancellation. Closing terminates the VM and releases the pool slot without deleting host files. If Gondolin reports a VM cleanup failure, the pool rejects all waiting and future turns until the bot process restarts.

### VM resources and mounts

Both QEMU and krun VMs (including the krun startup check) use the following resource profile:

- 2 vCPUs
- 2.5 GiB of RAM (`2560M`)
- 8 GiB virtual root disk

The guest `/root` and `/tmp` directories are tmpfs mounts. Place large build caches and intermediate artifacts on the virtual root disk, such as under `/opt/build`. Copy files that must persist after the turn to `scratch/`.

Commands start in `/workspace/<chatId>`. The table below lists every host mount exposed to the guest. Host session logs (`log.jsonl`, `context.jsonl`), workspace bootstrap files, and other chats are not mounted.

| Guest path | Host path | Default mode | With `writableWorkspaceContent: true` |
| --- | --- | --- | --- |
| `/workspace/<chatId>/MEMORY.md` | `<chatDir>/MEMORY.md` | Read and write | Read and write |
| `/workspace/<chatId>/scratch` | `<chatDir>/scratch` | Read and write | Read and write |
| `/workspace/<chatId>/attachments` | `<chatDir>/attachments` | Read-only | Read and write |
| `/workspace/<chatId>/skills` | `<chatDir>/skills` | Read-only | Read and write |
| `/workspace/skills` | `<workspace>/skills` | Read-only | Read and write |

Only enable `writableWorkspaceContent: true` for trusted chats because edits to `/workspace/skills` affect every chat sharing that workspace. Pass the same `writableWorkspaceContent` value to `buildBaseSystemPrompt()` so the agent sees the real permissions.

### Filesystem safety checks

Workspace mounts enforce these restrictions on host entries:

- Guests cannot remove a mount root directory, change its permissions, rename it, or create symbolic or hard links inside any mounted directory. Run builds that require links on the VM root disk and copy regular output files to `scratch/`.
- Mount operations reject existing symbolic links, hard-linked files (`nlink !== 1`), and special files with `EACCES`.
- Safety checks never delete host files. Fix or remove rejected entries while the bot is stopped.
- Gondolin mount operations still open paths after preflight checks. Do not let another host process replace workspace files or directories while the bot is running.

### Network policy and web secrets

Every turn VM allows outbound public HTTP and HTTPS. Private IP ranges, loopback addresses, raw TCP and UDP, and WebSocket upgrades are blocked. Because a guest can send chat-visible data to public hosts, allow only trusted users or groups to invoke guest tools.

Pass `secrets` on `VMSandboxOptions` to expose scoped credentials to guest HTTP requests without placing real values inside the VM. The sandbox never forwards the host process environment automatically.

Validation and runtime rules for `secrets`:

- **Keys.** Each key is a guest environment variable name matching `/^[A-Za-z_][A-Za-z0-9_]*$/` (excluding `__proto__`) and must be distinct case-insensitively.
- **Hosts.** `hosts` must contain at least one exact hostname without wildcards, ports, or paths.
- **Values.** An absent or blank `value` disables that secret while still validating its key and `hosts`. Non-empty values must contain only printable ASCII characters (`0x20` to `0x7E`). Invalid entries throw `SandboxConfigError` without logging secret values.
- **Placeholder substitution.** Gondolin generates a fresh per-turn placeholder for each enabled secret and injects only the placeholder into the VM environment. The host HTTP proxy substitutes the real secret in outbound request headers, including Basic Auth headers used by HTTPS Git. Store raw tokens on the host without an auth scheme prefix.
- **Request boundary.** A secret is valid for any path and any HTTP method on its approved `hosts` over HTTPS on port 443. The proxy denies substitution in routing headers (`Connection`, `Content-Length`, `Forwarded`, `Host`, `Keep-Alive`, `Proxy-Authorization`, `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, and `X-Forwarded-Host`). It also rejects already-expanded secret values on redirected hops and never substitutes secrets into query strings or request bodies.
- **Scope limits.** Secret host lists do not restrict unrelated public HTTP and HTTPS traffic. Every chat sharing a `VMSandbox` instance shares the authority of its configured `secrets`. Use least-privilege credentials such as repository-scoped fine-grained tokens.
