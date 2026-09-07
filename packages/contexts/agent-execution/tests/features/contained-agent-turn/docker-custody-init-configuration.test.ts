import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { configuration, invalidConfigurations, prepareBootstrapProject } from "./docker-custody-init-bootstrap-fixture.ts";

const root = await prepareBootstrapProject({after});
const {parseDockerCustodyInitConfiguration: parse, DOCKER_CUSTODY_INIT_CONFIGURATION_MAX_BYTES: maximum} =
  await import(pathToFileURL(`${root}/init/docker-custody-init-configuration.js`).href);
const reject = (input: unknown): void => {
  assert.throws(() => parse(input), {name: "Error", message: "invalid custody init configuration"});
};

test("source-loaded decoder preserves exactly the nine options and freezes nested data", () => {
  const parsed = parse(JSON.stringify(configuration));
  assert.deepEqual(parsed, configuration);
  for (const value of [parsed, parsed.observedIdentity, parsed.allowedEnvironmentNames]) {assert.ok(Object.isFrozen(value));}
  assert.equal(Object.keys(parsed).length, 9);
});

for (const [label, input] of invalidConfigurations) {
  test(`decoder rejects ${label} with a generic error`, () => reject(input));
}

for (const field of Object.keys(configuration)) {
  test(`decoder requires ${field}`, () => {
    const missing: Record<string, unknown> = {...configuration};
    delete missing[field];
    reject(JSON.stringify(missing));
  });
}

for (const field of ["maximumStderrBytes", "maximumStdinBytes", "maximumStdoutBytes", "maximumProviderRuntimeMs", "shutdownGraceMs"]) {
  test(`decoder validates existing positive safe integer range for ${field}`, () => {
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, true, [], {}]) {
      reject(JSON.stringify({...configuration, [field]: invalid}));
    }
    reject(JSON.stringify(configuration).replace(`"${field}":${configuration[field as keyof typeof configuration]}`, `"${field}":-0`));
    for (const valid of [1, Number.MAX_SAFE_INTEGER]) {
      assert.equal(parse(JSON.stringify({...configuration, [field]: valid}))[field], valid);
    }
  });
}

test("decoder enforces protocol identity values and exact nested keys", () => {
  for (const field of Object.keys(configuration.observedIdentity)) {
    for (const invalid of [null, 1, [], {}, "", "secret\nvalue", "x".repeat(257)]) {
      reject(JSON.stringify({...configuration, observedIdentity: {...configuration.observedIdentity, [field]: invalid}}));
    }
    const missing: Record<string, unknown> = {...configuration.observedIdentity};
    delete missing[field];
    reject(JSON.stringify({...configuration, observedIdentity: missing}));
  }
  for (const invalid of [null, [], "identity", {...configuration.observedIdentity, extra: "DO_NOT_ECHO"},
    {...configuration.observedIdentity, protocol: "ar.docker-custody-init/v2"},
    {...configuration.observedIdentity, containerImageSha256: "A".repeat(64)}]) {
    reject(JSON.stringify({...configuration, observedIdentity: invalid}));
  }
});

test("decoder bounds and validates environment allowlist", () => {
  for (const invalid of [null, {}, "HOME", [1], [[]], ["HOME", "HOME"], ["lowercase"], ["A=B"], [""],
    ["A".repeat(129)], ["A\0"], Array.from({length: 129}, (_, index) => `KEY_${index}`)]) {
    reject(JSON.stringify({...configuration, allowedEnvironmentNames: invalid}));
  }
  for (const valid of [[], ["A".repeat(128)], Array.from({length: 128}, (_, index) => `KEY_${index}`)]) {
    assert.deepEqual(parse(JSON.stringify({...configuration, allowedEnvironmentNames: valid})).allowedEnvironmentNames, valid);
  }
});

test("decoder requires a bounded canonical absolute provider slot and independent digest format", () => {
  for (const executablePath of [null, {}, [], 7, "", "provider-entrypoint", "/ar-custody-node", "/ar-custody-init.mjs",
    "/x/../provider-entrypoint", "//provider-entrypoint", "/x//provider-entrypoint", "/provider-entrypoint/",
    "/x\0/provider-entrypoint", `/${"x".repeat(4096)}/provider-entrypoint`]) {
    reject(JSON.stringify({...configuration, executablePath}));
  }
  for (const executableSha256 of [null, {}, [], 1, "", "C".repeat(64), "c".repeat(63), `sha256:${"c".repeat(64)}`]) {
    reject(JSON.stringify({...configuration, executableSha256}));
  }
  const executablePath = `/${"x".repeat(4096 - "/".length - "/provider-entrypoint".length)}/provider-entrypoint`;
  assert.equal(parse(JSON.stringify({...configuration, executablePath})).executablePath, executablePath);
});

test("decoder bounds UTF-8 bytes before parsing and accepts the exact byte boundary", () => {
  const valid = JSON.stringify(configuration);
  assert.deepEqual(parse(valid + " ".repeat(maximum - Buffer.byteLength(valid))), configuration);
  reject(valid + " ".repeat(maximum - Buffer.byteLength(valid) + 1));
  const multibyte = JSON.stringify({...configuration, unknown: "🚀".repeat(9_000)});
  assert.ok(multibyte.length < maximum && Buffer.byteLength(multibyte) > maximum);
  reject(multibyte);
  reject(JSON.stringify(configuration).replace("workspace:test", "\uD800"));
  reject({toString: () => valid});
});
