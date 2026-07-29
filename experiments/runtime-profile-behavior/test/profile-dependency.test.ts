import assert from "node:assert/strict";
import test from "node:test";

import {
  ProfileDependencyError,
  resolveProfileExecutable,
  resolveProfileFileReference,
} from "../src/features/profile-capture/resolve-dependency.ts";

const root = "/profile/revision/source";

test("relative resources belong to the artifact closure", () => {
  assert.deepEqual(resolveProfileFileReference(root, "skills/review.md"), {
    kind: "artifact",
    relativePath: "skills/review.md",
  });
  assert.deepEqual(resolveProfileExecutable(root, ["bin/helper", "--safe"]), {
    kind: "artifact",
    relativePath: "bin/helper",
  });
});

test("ambient executables become explicit external bindings", () => {
  assert.deepEqual(resolveProfileExecutable(root, ["node", "server.mjs"]), {
    kind: "external-executable-binding",
    executable: "node",
    resolution: "path-search",
  });
  assert.deepEqual(resolveProfileExecutable(root, ["/usr/bin/node"]), {
    kind: "external-executable-binding",
    executable: "/usr/bin/node",
    resolution: "absolute",
  });
});

test("shell hooks are explicitly non-hermetic compatibility inputs", () => {
  assert.deepEqual(resolveProfileExecutable(root, "node helper.mjs | tee log"), {
    kind: "non-hermetic-shell",
    command: "node helper.mjs | tee log",
  });
});

test("relative references cannot escape the profile root", () => {
  assert.throws(
    () => resolveProfileFileReference(root, "../../credentials.json"),
    (error: unknown) =>
      error instanceof ProfileDependencyError &&
      error.code === "ESCAPES_PROFILE_ROOT",
  );
});
