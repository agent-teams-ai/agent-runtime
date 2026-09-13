import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const findRepoRoot = (from = fileURLToPath(import.meta.url)): string => {
  let dir = dirname(from);
  while (!existsSync(join(dir, "pnpm-workspace.yaml")) || !existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("repository root not found");
    }
    dir = parent;
  }
  return dir;
};
