import { z } from "zod";

/** Enforcing component of a bounded producer launch and how it enforces. */
export const resourceLimiterSchema = z.strictObject({
  mechanism: z.enum([
    "prlimit",
    "darwin-ulimit-rss-watchdog",
    "windows-job-object",
  ]),
  configured_path: z.string(),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  arguments: z.array(z.string()),
});
