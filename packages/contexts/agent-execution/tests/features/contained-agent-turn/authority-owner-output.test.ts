import assert from "node:assert/strict";
import test from "node:test";
import {ownerOutputValue} from "../../../dist/features/contained-agent-turn/composition/authority-owner-boundary.js";

for (const freezeReceipt of [false, true]) {
  test(`owner output preserves independent envelope and receipt freeze guarantees: receipt=${freezeReceipt}`, async () => {
    const receipt = {revision: 1};
    const source = Object.freeze({receipt: freezeReceipt ? Object.freeze(receipt) : Object.seal(receipt)});
    const copied = await ownerOutputValue(Promise.resolve(source));
    assert.notStrictEqual(copied, source);
    assert.notStrictEqual(copied.receipt, receipt);
    assert.equal(Object.isFrozen(copied), true);
    assert.equal(Object.isFrozen(copied.receipt), freezeReceipt);
    if (!freezeReceipt) {
      receipt.revision = 2;
      assert.equal(copied.receipt.revision, 1);
    }
  });
}

test("sealed envelope is not promoted even with a frozen nested receipt", async () => {
  const source = Object.seal({receipt: Object.freeze({revision: 1})});
  const copied = await ownerOutputValue(Promise.resolve(source));
  assert.equal(Object.isFrozen(copied), false);
  assert.equal(Object.isFrozen(copied.receipt), true);
});

test("owner output refuses nested proxies and getters without executing them", async () => {
  let reads = 0;
  const proxy = new Proxy({}, {ownKeys() {reads += 1; throw new Error("must not reflect");}});
  await assert.rejects(ownerOutputValue(Promise.resolve(Object.freeze({receipt: proxy}))));
  const getter = Object.freeze({get receipt() {reads += 1; throw new Error("must not read");}});
  await assert.rejects(ownerOutputValue(Promise.resolve(getter)));
  assert.equal(reads, 0);
});

test("owner output refuses promise proxies before reading then", async () => {
  let reads = 0;
  const promise = new Proxy(Promise.resolve(Object.freeze({kind: "settled"})), {
    get() {reads += 1; throw new Error("must not read");},
  });
  await assert.rejects(ownerOutputValue(promise));
  assert.equal(reads, 0);
});
