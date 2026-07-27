import { join } from "node:path";

import type { ProviderExecutable } from "./model.ts";

const localBin = (name: string): string =>
  join(process.cwd(), "node_modules", ".bin", name);

export const PROVIDERS: readonly ProviderExecutable[] = [
  {
    id: "claude",
    candidates: ["claude"],
    versionArgs: ["--version"],
  },
  {
    id: "codex",
    candidates: ["codex"],
    versionArgs: ["--version"],
  },
  {
    id: "opencode",
    candidates: [localBin("opencode"), "opencode"],
    versionArgs: ["--version"],
  },
];
