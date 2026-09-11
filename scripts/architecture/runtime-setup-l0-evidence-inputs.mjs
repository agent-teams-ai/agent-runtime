import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { evidenceFiles, evidenceRoots } from "./runtime-setup-l0-evidence-spec.mjs";
import { parseTrackedEvidenceEntries } from "./runtime-setup-l0-evidence-validation.mjs";

const pathspecs = paths => paths.map(path => `:(literal)${path}`);

export const createEvidenceInputs = ({
  repositoryRoot, git, readRevisionFile = (revision, path) => git("show", `${revision}:${path}`),
  roots = evidenceRoots, files = evidenceFiles,
}) => {
  const categories = ["fixtures", "sources", "tests"];
  const inputs = category => [...new Set([...roots[category], ...files[category]])];
  const allInputs = [...new Set(categories.flatMap(inputs))];

  const hashFileSet = async category => {
    const paths = inputs(category);
    assert.ok(paths.length > 0, `${category} must configure evidence inputs`);
    const entries = parseTrackedEvidenceEntries(
      git("ls-files", "--stage", "-z", "--", ...pathspecs(paths)),
    );
    const trackedPaths = new Set(entries.map(entry => entry.path));
    for (const path of roots[category]) {
      assert.ok((await lstat(join(repositoryRoot, path))).isDirectory(),
        `${path} must be an evidence directory`);
      assert.ok(entries.some(entry => entry.path.startsWith(`${path}/`)),
        `${path} must contain tracked evidence inputs`);
    }
    for (const path of files[category]) {
      assert.ok(trackedPaths.has(path), `${path} must be a tracked evidence input`);
      assert.ok((await lstat(join(repositoryRoot, path))).isFile(),
        `${path} must be a regular evidence file`);
    }
    // Overlapping roots and exact file inputs contribute each path only once.
    const uniqueEntries = new Map(entries.map(entry => [entry.path, entry]));
    const digest = createHash("sha256");
    for (const { mode, path } of uniqueEntries.values()) {
      const content = await readFile(join(repositoryRoot, path));
      digest.update(path);
      digest.update("\0");
      digest.update(mode);
      digest.update("\0");
      digest.update(createHash("sha256").update(content).digest("hex"));
      digest.update("\n");
    }
    return { fileCount: uniqueEntries.size, sha256: digest.digest("hex") };
  };

  return {
    artifactDigests: async () => Object.fromEntries(await Promise.all(
      categories.map(async category => [category, await hashFileSet(category)]),
    )),
    artifactDigestsAtRevision: async revision => {
      assert.match(revision, /^[a-f0-9]{40}$/u, "historical revision must be exact");
      return Object.fromEntries(categories.map(category => {
        const rows = git("ls-tree", "-r", "-z", revision, "--", ...inputs(category))
          .split("\0").filter(Boolean).map(row => {
            const separator = row.indexOf("\t");
            assert.notEqual(separator, -1, "historical entry lacks a path separator");
            const header = row.slice(0, separator);
            const path = row.slice(separator + 1);
            const [mode, type, objectId] = header.split(" ");
            assert.equal(type, "blob", `${path} must be a historical blob`);
            return `${mode} ${objectId} 0\t${path}\0`;
          }).join("");
        const entries = parseTrackedEvidenceEntries(rows);
        const paths = new Set(entries.map(entry => entry.path));
        for (const root of roots[category]) {
          assert.ok(entries.some(entry => entry.path.startsWith(`${root}/`)),
            `${root} has no historical evidence inputs`);
        }
        for (const path of files[category]) {
          assert.ok(paths.has(path), `${path} is missing from historical evidence`);
        }
        const digest = createHash("sha256");
        for (const { mode, path } of entries) {
          digest.update(path); digest.update("\0"); digest.update(mode); digest.update("\0");
          digest.update(createHash("sha256").update(readRevisionFile(revision, path)).digest("hex"));
          digest.update("\n");
        }
        return [category, { fileCount: entries.length, sha256: digest.digest("hex") }];
      }));
    },
    assertEvidenceRootsClean: () => {
      assert.equal(
        git("status", "--porcelain=v1", "--untracked-files=all", "--", ...pathspecs(allInputs)).trim(),
        "",
        "captured product source, tests, fixtures, and build inputs must match the source revision",
      );
    },
    assertEvidenceRootsMatchRevision: revision => {
      assert.equal(
        git("diff", "--name-only", revision, "HEAD", "--", ...pathspecs(allInputs)).trim(),
        "",
        "captured product source, tests, fixtures, and build inputs must match the retained product revision",
      );
    },
  };
};
