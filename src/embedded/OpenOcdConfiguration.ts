import { statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Resolves one caller-selected configuration file to the first configured root
 * that contains it, the same order OpenOCD searches its -s directories in.
 * Relative-only, with no parent traversal, so the model chooses among the
 * configurations the host has been given rather than naming any file on disk.
 */
export const resolveOpenOcdConfigFile = (
  candidate: string,
  roots: readonly string[],
  exists: (path: string) => boolean = isFile,
): { readonly resolved: string } | { readonly reason: string } => {
  if (candidate.length === 0 || candidate.includes("\0"))
    return { reason: "must be non-empty and must not contain NUL" };
  if (isAbsolute(candidate))
    return { reason: "must be relative to a configured script root" };
  const normalized = normalize(candidate);
  if (normalized === ".." || normalized.startsWith(`..${sep}`))
    return { reason: "must not traverse outside a configured script root" };
  const resolved = roots
    .map((root) => join(root, normalized))
    .find((path) => exists(path));
  return resolved === undefined
    ? { reason: `${candidate} was not found in any configured script root` }
    : { resolved };
};

/**
 * Ports are set after the configuration files so REA's channel wins over a
 * port a configuration file happens to set. OpenOCD enters its run stage by
 * itself when no configuration called init.
 */
export const openOcdArguments = (
  scriptRoots: readonly string[],
  configFiles: readonly string[],
  ports: { readonly gdbPort: number; readonly tclPort: number },
): string[] => [
  ...scriptRoots.flatMap((root) => ["-s", root]),
  ...configFiles.flatMap((file) => ["-f", file]),
  "-c",
  "telnet_port disabled",
  "-c",
  `tcl_port ${String(ports.tclPort)}`,
  "-c",
  `gdb_port ${String(ports.gdbPort)}`,
];
