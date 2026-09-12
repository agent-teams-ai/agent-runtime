import assert from "node:assert/strict";
import {setImmediate} from "node:timers/promises";
import test from "node:test";
import {createOrdinarySecurityTransactions} from "../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/ordinary-security-transactions.js";
import type {DispatchPgClient} from "../dist/features/contained-turn-dispatch-authority/adapters/outbound/postgres/transaction.js";
test("ordinary transaction disposal joins abandoned acquisition and releases a late borrowed client without BEGIN", async () => {
  let acquired!: (client: DispatchPgClient) => void; let queries = 0; let discarded = false;
  const transactions = createOrdinarySecurityTransactions({connect: () => new Promise(resolve => {acquired = resolve;})});
  const operation = transactions.run(async () => 1);
  const rejected = assert.rejects(operation, /ORDINARY_SECURITY_DATABASE_UNAVAILABLE/u);
  await transactions.close(); await rejected;
  acquired({query: async () => {queries += 1; return {rows: [], rowCount: 0};}, release: discard => {discarded = discard === true;}});
  await setImmediate(); assert.equal(queries, 0); assert.equal(discarded, true);
});
