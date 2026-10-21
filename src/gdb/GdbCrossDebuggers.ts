/** The selection that runs REA_GDB_COMMAND rather than a cross debugger. */
export const HOST_DEBUGGER = "host";

/**
 * Names each cross debugger in REA_GDB_CROSS_DEBUGGERS (paths separated by ";")
 * by the toolchain triple in its file name, so .../arm-none-eabi-gdb.exe is
 * arm-none-eabi and .../xtensa-esp32s3-elf-gdb is xtensa-esp32s3-elf. The first
 * path for a triple wins, and "host" stays reserved for the host GDB.
 */
export const parseGdbCrossDebuggers = (
  value: string | undefined,
): ReadonlyMap<string, string> => {
  const debuggers = new Map<string, string>();
  for (const entry of (value ?? "").split(";")) {
    const path = entry.trim();
    const name = (path.split(/[\\/]/u).at(-1) ?? "")
      .replace(/\.exe$/iu, "")
      .replace(/-gdb$/u, "");
    if (path.length > 0 && name !== HOST_DEBUGGER && !debuggers.has(name))
      debuggers.set(name, path);
  }
  return debuggers;
};
