import {after, test} from "node:test";
import {guardHandles, runContractSuite} from "@get-modular/conformance";
import {createInMemoryOrdinaryOperationStore, inMemoryOrdinaryStoreDeclaration} from "./support/in-memory-ordinary-store.ts";
import {ordinaryStoreSuite} from "./support/ordinary-store-suite.ts";

const handles = guardHandles();

runContractSuite(ordinaryStoreSuite,
  {name: "in-memory", declaration: inMemoryOrdinaryStoreDeclaration, create: () => createInMemoryOrdinaryOperationStore()},
  // Wrapped so the cases register from this file, not from the conformance package (CI checks the registration site).
  (name, body) => test(name, body));

after(() => handles.check());
