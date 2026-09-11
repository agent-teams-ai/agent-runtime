import assert from "node:assert/strict";
import test from "node:test";
import { outcomeNormalizer, registerPassiveSetupScenarios, createDirectReferenceHost } from "./helpers/assembly-direct-reference.ts";

registerPassiveSetupScenarios("direct reference", async () => createDirectReferenceHost());

// Portable regression for sourceModel refs exposed only by successful Darwin
// inspection. Exercise the exact normalizer used by the paired Host oracle.
for (const [field, domain] of [
  ["collectorRef", "claude-code-collector/v2:hmac-sha256"],
  ["topologyRef", "claude-code-topology/v2:hmac-sha256"],
] as const) {
  test(`exact parity normalizes only ${field} HMAC bytes and preserves bijection`, () => {
    const ref = (byte: string) => `${domain}:${byte.repeat(64)}`;
    const result = (identity: string) => ({
      status: "observed", diagnostics: [], expectedLimitations: { precedence: "not-evaluated" },
      sourceModel: { [field]: identity, contract: "claude-code-observed-source-plan/v1" },
    });
    const actual = outcomeNormalizer();
    const expected = outcomeNormalizer();
    assert.deepEqual(actual(result(ref("a"))), expected(result(ref("b"))));
    assert.deepEqual(actual(result(ref("c"))), expected(result(ref("d"))));
    assert.deepEqual(actual(result(ref("a"))), expected(result(ref("b"))));
    assert.notDeepEqual(actual(result(ref("a"))), expected(result(ref("d"))));
    assert.notDeepEqual(actual(result(ref("e"))), expected(result(ref("b"))));
    assert.deepEqual(outcomeNormalizer()(result(ref("a"))), result(`${domain}:opaque-0`));

    for (const identity of [
      ref("a").replace("/v2", "/v3"), ref("a").replace("sha256", "sha512"),
      ref("a").slice(0, -1), ref("a").toUpperCase(),
      `${field === "collectorRef" ? "claude-code-topology" : "claude-code-collector"}/v2:hmac-sha256:${"a".repeat(64)}`,
    ]) {
      assert.deepEqual(outcomeNormalizer()(result(identity)), result(identity));
    }
    for (const otherField of ["semanticDigest", "value", "subject", "safeRef",
      field === "collectorRef" ? "topologyRef" : "collectorRef"]) {
      const untouched = { [otherField]: ref("a") };
      assert.deepEqual(outcomeNormalizer()(untouched), untouched);
    }
    for (const changed of [
      { ...result(ref("b")), status: "partial" },
      { ...result(ref("b")), diagnostics: [{ code: "source_unreadable" }] },
      { ...result(ref("b")), expectedLimitations: { precedence: "evaluated" } },
      { ...result(ref("b")), semanticDigest: ref("b") },
    ]) {
      assert.notDeepEqual(outcomeNormalizer()(result(ref("a"))), outcomeNormalizer()(changed));
    }
  });
}

// Portable successful-Darwin structure: private HMAC order differs by Host,
// public refs are re-HMACed, and semantic values remain attached to each source.
const fixture = (order: readonly string[], bytes: readonly string[]) => {
    const refs = Object.fromEntries(["user", "shared-project", "project-local"].map((role, index) =>
      [role, `claude-code-setup-source:${bytes[index]!.repeat(64)}`]));
    return {
      status: "observed", expectedLimitations: { precedence: "not-evaluated" },
      sourceModel: { contract: "claude-code-observed-source-plan/v1" },
      diagnostics: ["user", "shared-project"].map(role => ({ code: "config_too_large", safeRef: refs[role] }))
        .toSorted((a, b) => a.safeRef! < b.safeRef! ? -1 : 1),
      sourceObservations: order.map(role => ({ role, selectionBasis: "static-preview",
        displayPath: `$CLAUDE_OBSERVED/${role}/static-preview/settings.json`, sourceRef: refs[role],
        status: role === "project-local" ? "missing" : "observed",
        ...(role === "project-local" ? {} : { semanticDigest: `semantic-${role}` }),
      })),
      observedPortableIntent: order.filter(role => role !== "project-local").flatMap(role => [
        { key: "effortLevel", value: role === "user" ? "high" : "low", sourceRef: refs[role] },
        { key: "model", selection: { kind: "alias", value: role === "user" ? "sonnet" : "opus" }, sourceRef: refs[role] },
      ]),
      deferredObservations: order.filter(role => role !== "project-local").flatMap(role => [
        { key: "model", form: "environment", status: "deferred", sourceRef: refs[role] },
        { key: "model", form: "template", status: "deferred", sourceRef: refs[role] },
      ]),
      nextActions: ["review_configuration", "trust_workspace"],
    };
  };
test("Claude keyed source ordering retains semantic values and ordering relationships", () => {
  const left = fixture(["user", "shared-project", "project-local"], ["a", "b", "c"]);
  const right = fixture(["shared-project", "project-local", "user"], ["f", "e", "d"]);
  assert.deepEqual(outcomeNormalizer()(left), outcomeNormalizer()(right));
  for (const mutate of [
    (value: typeof right) => { value.sourceObservations[0]!.semanticDigest = "different"; },
    (value: typeof right) => { value.observedPortableIntent[0]!.value = "medium"; },
    (value: typeof right) => { value.observedPortableIntent[1]!.selection!.value = "haiku"; },
    (value: typeof right) => { value.observedPortableIntent[0]!.sourceRef = value.sourceObservations[1]!.sourceRef; },
    (value: typeof right) => { value.deferredObservations.reverse(); },
    (value: typeof right) => { value.observedPortableIntent.reverse(); },
    (value: typeof right) => { value.sourceObservations.reverse(); },
    (value: typeof right) => { value.diagnostics.reverse(); },
    (value: typeof right) => { value.nextActions.reverse(); },
    (value: typeof right) => { [value.observedPortableIntent[0], value.observedPortableIntent[1]] =
      [value.observedPortableIntent[1]!, value.observedPortableIntent[0]!]; },
    (value: typeof right) => { [value.deferredObservations[0], value.deferredObservations[1]] =
      [value.deferredObservations[1]!, value.deferredObservations[0]!]; },
  ]) {
    const changed = structuredClone(right);
    mutate(changed);
    assert.throws(() => assert.deepEqual(outcomeNormalizer()(left), outcomeNormalizer()(changed)));
  }
});
