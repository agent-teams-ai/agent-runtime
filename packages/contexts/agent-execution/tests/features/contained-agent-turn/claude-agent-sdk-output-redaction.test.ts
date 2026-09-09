import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeCanonicalOutputRedactor,
  redactClaudeCanonicalText,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-output-redaction.js";

const credential = "InventedAlpha1234";

test("redacts contextual Bearer credentials in fallback and at every stream boundary", () => {
  const value = `Authorization: Bearer ${credential} done`;
  assert.equal(redactClaudeCanonicalText(value), "<redacted> <redacted> <redacted> done");
  for (let boundary = 0; boundary <= value.length; boundary += 1) {
    const redactor = new ClaudeCanonicalOutputRedactor();
    assert.equal(redactor.push(value.slice(0, boundary)) + redactor.push(value.slice(boundary)) + redactor.finish(),
      "<redacted> <redacted> <redacted> done");
  }
});

const assertAllBoundaries = (value: string, expected: string): void => {
  assert.equal(redactClaudeCanonicalText(value), expected);
  for (let boundary = 0; boundary <= value.length; boundary += 1) {
    const redactor = new ClaudeCanonicalOutputRedactor();
    assert.equal(redactor.push(value.slice(0, boundary)) + redactor.push(value.slice(boundary)) + redactor.finish(), expected);
  }
  for (const characters of [Array.from(value), value.split("")]) {
    const redactor = new ClaudeCanonicalOutputRedactor();
    assert.equal(characters.map(character => redactor.push(character)).join("") + redactor.finish(), expected);
  }
};

test("retains credential context through whitespace and quoted assignments", () => {
  for (const length of [16, 23, 31]) {
    const invented = "InventedAlpha1234".padEnd(length, "Z");
    for (const space of [" ", "   ", "\n", "\r\n\t"]) {
      assertAllBoundaries(`Authorization:${space}Bearer${space}${invented} done`,
        `<redacted>${space}<redacted>${space}<redacted> done`);
      assertAllBoundaries(`Bearer${space}${invented} done`, `<redacted>${space}<redacted> done`);
      for (const key of ["api_key", "access-token", "auth", "authorization", "credential", "password", "secret"]) {
        assertAllBoundaries(`{"${key}":${space}"${invented}"} done`, `<redacted>${space}<redacted> done`);
        assertAllBoundaries(`'${key}'${space}=${space}'${invented}' done`,
          `'${key}'${space}<redacted>${space}<redacted> done`);
        assertAllBoundaries(`{"${key}":"${invented}"} done`, "<redacted> done");
        assertAllBoundaries(`"${key}"${space}:"${invented}" done`, `"${key}"${space}<redacted> done`);
      }
      assertAllBoundaries(`{"Authorization":"Bearer${space}${invented}"} done`,
        `<redacted>${space}<redacted> done`);
    }
  }
});

test("preserves benign text and clears completed credential context", () => {
  for (const value of ["ordinary text\nwith  spacing\tintact", "the secret of success", "authorization is required",
    "api_key documentation", "Bearer-like examples", credential, "", "\n  "]) {
    assertAllBoundaries(value, value);
  }
  assertAllBoundaries(`password=short public text`, "<redacted> public text");
  const redactor = new ClaudeCanonicalOutputRedactor();
  assert.equal(redactor.push("Authorization:") + redactor.finish(), "<redacted>");
  assert.equal(redactor.push("public text") + redactor.finish(), "public text");
});

test("bounds pending token bytes and retains no unbounded whitespace context", () => {
  for (const character of ["x", "é"]) {
    const redactor = new ClaudeCanonicalOutputRedactor();
    const limit = 4096 / Buffer.byteLength(character);
    assert.equal(redactor.push(character.repeat(limit)), "");
    assert.equal(redactor.push(character), "<redacted>");
    assert.equal(redactor.push(character.repeat(10000)), "");
    assert.equal(redactor.push(" public ") + redactor.finish(), " public ");
    assert.equal(redactClaudeCanonicalText(character.repeat(limit + 10000) + " public "), "<redacted> public ");
  }
  const redactor = new ClaudeCanonicalOutputRedactor();
  assert.equal(redactor.push("Authorization: "), "<redacted> ");
  for (let index = 0; index < 100; index += 1) {
    assert.equal(redactor.push(" \n".repeat(100)), " \n".repeat(100));
  }
  assert.equal(redactor.push(`Bearer ${credential} public`) + redactor.finish(), "<redacted> <redacted> public");
});

test("P1 preserves labels after oversized suppressed padding", () => {
  assertAllBoundaries('{"padding":"' + "x".repeat(4100) + '","password": "InventedAlpha1234"} done',
    "<redacted> <redacted> done");
});

test("P1 retains quoted credentials across whitespace until closure", () => {
  assertAllBoundaries('{"password": "InventedAlpha1234 InventedBeta5678"} done',
    "<redacted> <redacted> <redacted> done");
});


test("quoted lexical state handles escapes, UTF-8 and prefixed Authorization labels", () => {
  for (const quote of ["\"", "'", "`"] ) {
    for (const space of [" ", "\t", "\n", "\r\n", " \n\t"]) {
      for (const prefix of ["password=", "**Authorization:", ">Authorization:", "note:Authorization:", "'secret' = "]) {
        const value = `${prefix}${quote}Inventedé😀${space}Beta\\${quote}Still${space}Gamma${quote} public text`;
        const expectedPrefix = prefix === "'secret' = " ? "'secret' <redacted> " : "";
        assertAllBoundaries(value, `${expectedPrefix}<redacted>${space}<redacted>${space}<redacted> public text`);
      }
    }
    assertAllBoundaries(`password=${quote}Alpha\\\\${quote} public text`, "<redacted> public text");
    assertAllBoundaries(`password=${quote}Alpha\\\nBeta Gamma${quote} public text`,
      "<redacted>\n<redacted> <redacted> public text");
  }
  for (const prefix of ["**", ">", "note:", "prose"]) {
    assertAllBoundaries(`${prefix}Authorization: InventedAlpha1234 done`, "<redacted> <redacted> done");
    assertAllBoundaries(`${prefix}Authorization: Bearer InventedAlpha1234 done`,
      "<redacted> <redacted> <redacted> done");
  }
});

test("suppressed UTF-8 tokens retain labels and bounded open-quote state", () => {
  assertAllBoundaries('{"padding":"' + "é😀".repeat(690) + '","password": "Alpha Beta"} done',
    "<redacted> <redacted> <redacted> done");
  const redactor = new ClaudeCanonicalOutputRedactor();
  assert.equal(redactor.push('password="' + "x".repeat(4100)), "<redacted>");
  for (let index = 0; index < 1000; index += 1) {
    assert.equal(redactor.push("x".repeat(1000)), "");
  }
  assert.equal(redactor.push(' Alpha\nBeta" public text') + redactor.finish(),
    " <redacted>\n<redacted> public text");
  assert.equal(redactor.push('password="unfinished') + redactor.finish(), "<redacted>");
  assert.equal(redactor.push("benign trailing text") + redactor.finish(), "benign trailing text");
});
