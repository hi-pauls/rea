# Reverse-engineering tool integrations

REA can call caller-supplied GNU objdump, GDB, Rizin and OpenOCD installations. REA does not install or update these tools. Static objdump/Rizin workflows use the same services from CLI and MCP. GDB sessions attached to a remote GDB server and OpenOCD sessions are available on Linux, macOS, and Windows, whereas GDB sessions that spawn a local inferior and the ephemeral GDB CLI command are available only on Linux. Persistent debugger sessions exist only for the lifetime of the REA MCP server process.

In a shared MCP server, unrestricted Rizin and Cutter commands, GDB console
commands, Rizin debugger start/close, and GDB debugger close retire any active
binary analysis session after the operation. This prevents a fresh analysis
provider from being rebound automatically while command effects may still be
writing. After the command and any background writers have stopped, call
`open_binary` explicitly before continuing analysis. A successful command
response alone does not prove that background writers have stopped. An active
Ghidra analysis session must be closed explicitly before an external mutation
can run.

## GNU objdump

`inspect_with_objdump` and `rea inspect-with-objdump` capture stdout and stderr as inline Evidence. Artifact inspection Evidence records SHA-256 digests before and after the provider call and whether those observed digests differ; this cannot prove the exact bytes consumed if the artifact changes during execution. Choose one artifact operation: `file_headers`, `section_headers`, `symbols`, `relocations`, `dwarf`, `disassemble`, or `disassemble_all`. `disassemble` maps to `-d`; `disassemble_all` maps to `-D` and has different symbol-boundary semantics. The pathless `inspect_with_objdump {"operation":"architectures"}` MCP call or `rea list-objdump-architectures` CLI command maps to `-i` and produces subjectless provider-capability Evidence describing BFD targets compiled into the installed binary, not a guarantee that a target is supported.

For DWARF, REA does not follow local debug links by default. Set `follow_debug_links` to `true` to pass `-WK`; external debug-file identities are not bound to Evidence when following links is enabled. The CLI flag is `--follow-debug-links`; `--no-follow-debug-links` or `--follow-debug-links=false` keeps the default. A separate `true` or `false` word after the flag is not its value. REA clears `DEBUGINFOD_URLS` in the objdump child environment to disable debuginfod network access on GNU binutils versions that do not support `-WE`. The complete raw output is authoritative; REA does not normalize it into a version-independent disassembly schema.

```sh
rea inspect-with-objdump ./program disassemble
rea inspect-with-objdump ./program dwarf
rea inspect-with-objdump ./program dwarf --follow-debug-links
```

Captured stdout and stderr are retained up to a 16 MiB combined limit; `output_truncated` marks output beyond that limit.

## GDB

Pass `remote_target` to `start_gdb_session` to connect to an existing GDB server, such as OpenOCD for an embedded target or `gdbserver` on another machine. Use the format `host:port`, `:port`, or a serial device path. Remote sessions do not spawn a local inferior and run on Linux, macOS, and Windows. There are no inferior output descriptors to verify, `inferior_tty` cannot be used, and closing the session disconnects from the server. This leaves the target in its current state and reports `target_state` as `unknown`. Embedded targets require the cross debugger for their architecture. Set `debugger` to the toolchain's triple, such as `arm-none-eabi` for Cortex-M, `xtensa-esp32s3-elf` for an ESP32-S3, or `riscv32-esp-elf` for an ESP32-C3. `REA_GDB_CROSS_DEBUGGERS` lists available cross debuggers as paths separated by `;`. Each file is named by its triple, such as `…/arm-none-eabi-gdb` for `arm-none-eabi`. The default `host` runs `REA_GDB_COMMAND`. An unknown name is refused with the list of configured ones.

```text
start_openocd_session {"config_files":["interface/jlink.cfg","target/stm32f4x.cfg"]}
start_gdb_session {"remote_target":":3333","debugger":"arm-none-eabi"}
gdb_console {"session_id":"…","command":"file ./firmware.elf"}
gdb_console {"session_id":"…","command":"monitor reset halt"}
close_gdb_session {"session_id":"…"}
close_openocd_session {"session_id":"…"}
```

GDB sessions that spawn a local inferior, including the one-shot `rea debug-with-gdb` CLI, are available only on Linux. REA verifies a live inferior's output descriptors through `/proc` before detaching it; it does not claim equivalent descriptor verification on macOS. Windows is also unsupported because owned Job Object cleanup can terminate debugger inferiors. On supported Linux hosts, `start_gdb_session`, `gdb_console`, `gdb_session_status`, and `close_gdb_session` manage a persistent GDB/MI session in MCP. The one-shot CLI requires a caller-selected durable TTY: `rea debug-with-gdb --inferior-tty /dev/pts/7 'file ./program'`. The TTY must remain available after GDB exits so a detached inferior can continue writing. MCP starts GDB with `--nx --quiet --interpreter=mi3`, retries initialization with MI2 if MI3 initialization returns an error and cleanup succeeds, waits for its prompt, and disables auto-loading. Pass optional `inferior_tty` to select the terminal that future inferior runs use; REA configures it before the session becomes ready and checks the exact value with GDB/MI. `gdb_session_status` reports the selected path, whether REA still considers the configuration verified, and whether invalid UTF-8 has been observed in MI bytes (`mi_invalid_utf8`) or stderr (`stderr_invalid_utf8`). Commands that can change the inferior TTY or redirect a run revoke that verification permanently for the session, so close retains GDB ownership if a live inferior remains. Closing a session with one live inferior and a verified TTY automatically detaches the target, which can resume execution; MCP clients receive destructive-operation annotations for this behavior. The console remains unrestricted and can run shell commands, change target state, access files, and use network in the REA process user's security context. Raw MI records and console/target/log streams are returned with Evidence; command output is retained up to 16 MiB and explicitly marked when truncated.

Before a normal close, REA checks for live GDB thread groups. If one remains and a durable `inferior_tty` is verified, REA asks GDB to detach it and confirms the detach before stopping the debugger. Without that sink, select and apply a disposition to each inferior through `gdb_console` (for example, detach or kill as appropriate), then retry close. REA never infers target ownership from a PID or path. When the MCP server shuts down, REA terminates only its directly owned GDB process after confirming no inferior or a sink-backed detach; otherwise it retains the process and its output streams for retry.

```text
start_gdb_session {"inferior_tty":"/dev/pts/7"}
gdb_console {"session_id":"…","command":"file ./program"}
gdb_console {"session_id":"…","command":"info files"}
gdb_session_status {"session_id":"…"}
close_gdb_session {"session_id":"…"}
```

## Rizin

`start_rizin_debug_session` and `rea debug-with-rizin` require an explicit `inferior_tty` on Linux. Rizin launches the target with stdout and stderr routed to that caller-selected TTY and `dbg.exitkills=false`; the target can therefore continue running and writing to the TTY after REA closes the debugger. This is a visible target output effect, and the caller is responsible for selecting a suitable terminal that remains available. Before closing, REA serializes after the active command, parses the structured `olj` descriptor list, detaches only a unique `ptrace://` descriptor, confirms its absence, reads back `dbg.exitkills=false`, and verifies `/proc/<pid>/fd/1` and `/proc/<pid>/fd/2` still identify the selected TTY by device and inode. Any malformed or ambiguous readback keeps the Rizin session owned for retry. Persistent Rizin debugger sessions are unavailable outside Linux because this verification depends on `/proc`.

Persistent command Evidence retains the caller-selected and resolved startup paths in `parameters.launch_provenance`. These paths describe launch provenance, not the current target after unrestricted commands. `rizin_debug_session_status.output_invalid_utf8` reports whether lossy frame decoding has been observed during the session. Command Evidence sets `output_invalid_utf8` only when loss was observed in frames collected for that command, including retained partial output; earlier startup or command frames do not mark later valid output as lossy.

```sh
rea debug-with-rizin --inferior-tty /dev/pts/7 ./program dr
```

`execute_rizin_command` and `rea execute-rizin-command` run one selected command against a local artifact. The one-shot profile uses `-N -q -c`, suppressing user settings and scripts while leaving plugins available. Commands and plugins run with the REA process user's security context and may access files, the network, or perform other actions. REA preserves raw output and does not claim that command-specific JSON has one universal schema.

```sh
rea execute-rizin-command ./program iI
```

Captured stdout and stderr are retained up to a 16 MiB combined limit; `output_truncated` marks output beyond that limit.

## OpenOCD

`start_openocd_session`, `openocd_command`, `openocd_session_status` and `close_openocd_session` manage an embedded target via a debug probe using OpenOCD on Linux, macOS and Windows. Each `start_openocd_session` call specifies configuration files, typically one interface file like `interface/jlink.cfg` and one target file like `target/stm32f4x.cfg`. Every file is resolved relative to the absolute roots in `REA_OPENOCD_SCRIPT_ROOTS`, which are separated by the platform path delimiter. The caller selects from the host-provided configurations. Absolute paths and parent traversal are rejected. A root normally covers the OpenOCD `scripts` directory, while additional roots can hold board and CPU configurations.

REA launches OpenOCD by passing `-s` for each root directory and `-f` for each configuration file, subsequently setting `telnet_port disabled`, `tcl_port`, and `gdb_port` after the configuration files to ensure REA's ports take precedence; during initialization, OpenOCD inspects the target and may reset it based on the configuration, with the session considered ready once OpenOCD responds to `capture version` on its TCL RPC port, while if OpenOCD exits prematurely, start outputs OpenOCD's own diagnostics, and the GDB server listens on `gdb_port` (defaulting to 3333, where `0` disables it) to which `start_gdb_session` with `remote_target` attaches.

`openocd_command` sends an unrestricted command through the TCL RPC port and returns the reply with Evidence. Examples include `halt`, `resume`, `reset halt`, `reg`, `mdw 0x08000000 4`, `flash banks`, or `program ./firmware.elf verify`. These commands can halt, reset, reprogram, or erase the device and write host files. OpenOCD processes commands in order. If a command exceeds the deadline, its result is `completion_status: unknown`. Late replies are discarded rather than passed to the next command. Closing sends `shutdown` and stops the owned process. REA neither resets nor halts the device, but shutdown handlers in the configuration can act on it. The target state is reported as `unknown`.

## Cutter bridge

Cutter commands use the local REA Python bridge and authenticated loopback messages.
The client and plugin must support the current v2 handshake; older peers are
rejected before dispatch because they cannot preserve cross-caller recovery proof.
The client checks the final encoded request against the bridge's 16 MiB frame
limit before dispatch; an oversized command does not retain a cleanup owner.
Discovery admits at most 256 descriptor candidates and reads and probes at most
eight concurrently. A larger directory reports `bridge_directory_capacity_exceeded`.

Terminal receipts are recovered before another command, including from a new CLI
invocation. A signed status response also confirms completion of older bridge
connections after its UI dispatch, preserving recovery proof for a caller whose
receipt another caller has acknowledged. Neither receipt recovery nor a status
probe retries the original command. Failed acknowledgements remain pending and
block new commands until they can be retried successfully. Status proof failures
identify `cutter_command` and retain `status` in
`details.diagnostics.auxiliary_operation`; malformed proof still blocks dispatch.
Descriptor failures likewise retain the requesting operation through cleanup.
Command admission reports typed cancellation and treats the caller's abort reason
as opaque metadata, without inferring cleanup ownership from it.

## Configuration and coverage

The optional `REA_OBJDUMP_COMMAND`, `REA_GDB_COMMAND`, and `REA_RIZIN_COMMAND` values select executable names or paths; otherwise REA searches `PATH`. The environment variable `REA_GDB_CROSS_DEBUGGERS` contains the list of cross debuggers that `debugger` can name. This variable has no default value. Sessions for OpenOCD require both `REA_OPENOCD_COMMAND` and `REA_OPENOCD_SCRIPT_ROOTS`. Values are passed directly to process spawning, not expanded as shell command lines. Provider versions and capabilities remain unknown until observed from the installed tool and verified in the corresponding real-provider lane.

Provider capture limits are separate from the MCP response budget. A result that fits the provider limit may still exceed the default 10 MiB MCP response budget and return a transport `resource_constraint`. Configure `REA_MCP_MAX_RESPONSE_BYTES` to match a larger client receive buffer when that client supports one; otherwise use retained Evidence/export or complete CLI JSON output. See [MCP response limits](./mcp-contracts.md#tool-results).
