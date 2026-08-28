import type { ConfigurationSourceReader } from "../../../codex-configuration-inspection/application/ports/outbound/configuration-source-reader.js";
import type { ClaudeCodeConfigurationSourceReader } from "../../application/ports/outbound/claude-code-configuration-source-reader.js";

export const createClaudeCodeConfigurationSourceReaderAdapter = (
  reader: ConfigurationSourceReader,
): ClaudeCodeConfigurationSourceReader => ({
  async read(source, _maximumBytes, options) {
    const result = await reader.read(
      source.absolutePath,
      source.canonicalPath,
      source.authorizedFileIdentity,
      source.custodyRoot,
      options,
    );
    return result.kind === "read"
      ? { bytes: result.bytes, status: "read" }
      : { status: result.kind };
  },
});
