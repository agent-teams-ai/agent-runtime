import assert from "node:assert/strict";
import { test } from "node:test";

import { DockerEngineError } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-error.js";
import { parseStrictJson as parseEngineStrictJson } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/strict-json.js";
import {
  parseStrictJson as parseSerializationStrictJson,
  StrictJsonParseError,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/serialization/strict-json.js";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const comparable = (value: unknown): unknown => value !== null && typeof value === "object" ? JSON.stringify(value) : value;

test("neutral and engine strict JSON entrypoints preserve valid value parity", () => {
  const values = [
    "null",
    "true",
    "42.5e-1",
    "\"plain\"",
    "\"\\uD83D\\uDE80\"",
    "[null,false,0,\"🚀\"]",
    "{\"nested\":{\"array\":[1,2,3]},\"escaped\":\"\\b\\f\\n\\r\\t\\\\\\/\\\"\"}",
    `${"[".repeat(32)}0${"]".repeat(32)}`,
    `[${Array.from({ length: 4096 }, () => "0").join(",")}]`,
  ];

  for (const source of values) {
    const bytes = utf8(source);
    assert.deepEqual(comparable(parseSerializationStrictJson(bytes)), comparable(parseEngineStrictJson(bytes)), source);
  }
});

test("neutral parser rejects malformed, duplicate-key, UTF-8, Unicode, depth, and array-bound inputs", () => {
  const invalid = [
    utf8("{\"missing\":}"),
    utf8("{\"duplicate\":1,\"duplicate\":2}"),
    Uint8Array.of(0x22, 0xc3, 0x28, 0x22),
    utf8("\"\\uD800x\""),
    utf8("\"\\uD800\""),
    utf8("{\"\\uD800\":1}"),
    utf8("\"\\uDC00\""),
    utf8(`${"[".repeat(33)}0${"]".repeat(33)}`),
    utf8(`[${Array.from({ length: 4097 }, () => "0").join(",")}]`),
  ];

  for (const bytes of invalid) {
    assert.throws(() => parseSerializationStrictJson(bytes), StrictJsonParseError);
  }
});

test("engine wrapper maps every strict parser rejection to the exact legacy error", () => {
  const invalid = [
    utf8("{"),
    utf8("{\"duplicate\":1,\"duplicate\":2}"),
    Uint8Array.of(0xff),
    utf8("\"\\uD800x\""),
    utf8("\"\\uD800\""),
    utf8("{\"\\uD800\":1}"),
    utf8(`${"[".repeat(33)}0${"]".repeat(33)}`),
    utf8(`[${Array.from({ length: 4097 }, () => "0").join(",")}]`),
  ];

  for (const bytes of invalid) {
    assert.throws(
      () => parseEngineStrictJson(bytes),
      error => error instanceof DockerEngineError && error.name === "DockerEngineError" &&
        error.code === "malformed-response" && error.message === "Docker Engine returned a malformed response" &&
        error.statusCode === undefined,
    );
  }
});
