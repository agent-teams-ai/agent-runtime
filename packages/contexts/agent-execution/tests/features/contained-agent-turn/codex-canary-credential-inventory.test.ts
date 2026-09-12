import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindCodexCanaryOutputInventory, readCodexCanaryCredentialInventory } from "../../live/codex-canary-credential-inventory.mjs";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("live canary inventories exact credential values and digests without an empty bypass", async () => {
  const root = await mkdtemp(join(tmpdir(), "ar-codex-canary-inventory-"));
  try {
    const file = join(root, "auth.json");
    const token = "synthetic-credential-fixture-only";
    const content = `{
  "tokens": {
    "access_token": "${token}",
    "refresh_token": "synthetic-refresh"
  }
}`;
    await writeFile(file, content, {mode: 0o600});
    const inventory = await readCodexCanaryCredentialInventory(file, 1);
    assert.equal(inventory.inventoryDigest, `sha256:${digest(content)}`);
    assert.equal(Object.hasOwn(inventory, "credentialBindingDigest"), false);
    assert.equal(inventory.credentialGeneration, 1);
    for (const value of [token, digest(token), `sha256:${digest(token)}`, digest(content)]) {
      assert.ok(inventory.sensitiveOutputTokens.includes(value));
    }
    assert.ok(Object.isFrozen(inventory) && Object.isFrozen(inventory.sensitiveOutputTokens));
    const binding = {credentialBindingDigest: "pa-opaque-owner-binding", credentialGeneration: 1};
    const projection = bindCodexCanaryOutputInventory(inventory, inventory, binding);
    assert.equal(projection.credentialBindingDigest, binding.credentialBindingDigest);
    assert.notEqual(projection.credentialBindingDigest, inventory.inventoryDigest);
    assert.equal(Object.hasOwn(projection, "inventoryDigest"), false);
    await writeFile(file, JSON.stringify({tokens: {access_token: "changed-synthetic-token"}}));
    const changed = await readCodexCanaryCredentialInventory(file, 1);
    assert.notEqual(changed.inventoryDigest, inventory.inventoryDigest);
    assert.throws(() => bindCodexCanaryOutputInventory(changed, inventory, binding), /invalid disposable/u);
    assert.throws(() => bindCodexCanaryOutputInventory(inventory, inventory,
      {...binding, credentialGeneration: 2}), /invalid disposable/u);
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
    for (const content of ["", "null", "[]", "{", "{}", "{\"token\":\"first\",\"token\":\"second\"}",
      "{\"nested\": [{\"token\":\"first\",\"token\":\"second\"}]}",
      "{\"nested\": {\"tok\\u0065n\":\"first\",\"token\":\"second\"}}",
      JSON.stringify({token: "x".repeat(4_097)}),
      JSON.stringify({tokens: Array.from({length: 86}, (_, i) => `synthetic-${i}`)}), " ".repeat(65_537)]) {
      await writeFile(file, content, {mode: 0o600});
      await assert.rejects(readCodexCanaryCredentialInventory(file, 1), error => {
        assert.match(error.message, /^invalid disposable Codex credential inventory$/u);
        assert.doesNotMatch(error.message, /first|second|token|nested/u);
        return true;
      });
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
