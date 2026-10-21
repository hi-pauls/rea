import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import { prepareHostResourceBound } from "../process/HostResourceBound.js";
import type { runPcapCommand } from "./PcapCommand.js";

const PRLIMIT_COMMAND_ENV = "REA_TSHARK_PRLIMIT_COMMAND";

/** Own native capture admission and the exact enforced resource profile. */
export const preparePcapNativeBound = async (
  environment: Readonly<Record<string, string | undefined>>,
  resources: ArtifactAnalysisResources,
): Promise<{
  nativeBound: NonNullable<Parameters<typeof runPcapCommand>[0]["nativeBound"]>;
  limitations: readonly string[];
}> => {
  try {
    const bound = await prepareHostResourceBound({
      configured: {
        address_space_bytes: 1024 ** 3,
        file_bytes: 64 * 1024 ** 2,
        cpu_seconds: 300,
      },
      prlimitVariable: PRLIMIT_COMMAND_ENV,
      environment,
      readLimits: (limits) => resources.readLimits(limits),
    });
    const memory =
      bound.memoryLimitBytes === undefined
        ? {}
        : { memoryLimitBytes: bound.memoryLimitBytes };
    return {
      nativeBound:
        bound.mechanism === "windows-job-object"
          ? memory
          : {
              limiter: {
                command: bound.enforcer,
                arguments: [...bound.enforcerArguments],
              },
              ...memory,
            },
      limitations: [bound.limitation],
    };
  } catch (cause) {
    if (cause instanceof AnalysisError) throw cause;
    const linux = process.platform === "linux";
    const reason = linux
      ? "Cannot establish the selected Linux resource limiter before processing capture bytes."
      : "Cannot establish the resource bound before processing capture bytes.";
    const remedy = linux
      ? ` Check that ${PRLIMIT_COMMAND_ENV} (default /usr/bin/prlimit) names an absolute, executable util-linux prlimit.`
      : "";
    throw new AnalysisCapabilityUnavailableError(
      "pcap",
      "inspect_pcap_capture",
      reason,
      {
        cause,
        userMessage: `${reason} (${cause instanceof Error ? cause.message : String(cause)})${remedy}`,
      },
    );
  }
};
