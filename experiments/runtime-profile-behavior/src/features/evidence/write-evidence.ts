import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const safeRunId = (date: Date): string =>
  date.toISOString().replaceAll(":", "-").replaceAll(".", "-");

export interface EvidenceRun {
  readonly id: string;
  readonly root: string;
  readonly evidenceRoot: string;
  readonly rawRoot: string;
  readonly sandboxRoot: string;
}

export const createEvidenceRun = async (
  baseRoot = join(process.cwd(), ".spike", "runs"),
): Promise<EvidenceRun> => {
  const id = safeRunId(new Date());
  const root = join(baseRoot, id);
  const evidenceRoot = join(root, "evidence");
  const rawRoot = join(root, "raw");
  const sandboxRoot = join(root, "sandbox");
  await Promise.all(
    [evidenceRoot, rawRoot, sandboxRoot].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  return { id, root, evidenceRoot, rawRoot, sandboxRoot };
};

export const writeJsonEvidence = async (
  path: string,
  value: unknown,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};
