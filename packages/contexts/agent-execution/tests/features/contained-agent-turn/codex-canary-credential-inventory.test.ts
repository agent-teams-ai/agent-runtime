import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCodexCanaryCredentialInventory } from "../../live/codex-canary-credential-inventory.mjs";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("live canary inventories exact credential values and digests without an empty bypass", async () => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-canary-inventory-"));
  try {
    const file = join(root, "auth.json");
    const token = "synthetic-credential-fixture-only";
    const content = JSON.stringify({tokens: {access_token: token, refresh_token: "synthetic-refresh"}});
    await writeFile(file, content, {mode: 0o600});
    const inventory = await readCodexCanaryCredentialInventory(file, 1);
    assert.equal(inventory.credentialBindingDigest, `sha256:${digest(content)}`);
    assert.equal(inventory.credentialGeneration, 1);
    for (const value of [token, digest(token), `sha256:${digest(token)}`, digest(content)]) {
      assert.ok(inventory.sensitiveOutputTokens.includes(value));
    }
    assert.ok(Object.isFrozen(inventory) && Object.isFrozen(inventory.sensitiveOutputTokens));
    await writeFile(file, JSON.stringify({tokens: {access_token: "changed-synthetic-token"}}));
    assert.notEqual((await readCodexCanaryCredentialInventory(file, 1)).credentialBindingDigest,
      inventory.credentialBindingDigest);
    const alias = join(root, "alias.json");
    await symlink(file, alias);
    await assert.rejects(readCodexCanaryCredentialInventory(alias, 1));
    await chmod(file, 0o644);
    await assert.rejects(readCodexCanaryCredentialInventory(file, 1), /invalid disposable/u);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("canary credential inventory fails closed on malformed, empty and excessive content", async () => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-canary-inventory-invalid-"));
  try {
    const file = join(root, "auth.json");
    for (const content of ["", "null", "[]", "{", "{}", JSON.stringify({token: "x".repeat(4_097)}),
      JSON.stringify({tokens: Array.from({length: 86}, (_, i) => `synthetic-${i}`)}), " ".repeat(65_537)]) {
      await writeFile(file, content, {mode: 0o600});
      await assert.rejects(readCodexCanaryCredentialInventory(file, 1), /invalid disposable/u);
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
