import {contractSuite} from "@get-modular/conformance";
import {OrdinaryStore} from "../../../../dist/composition/ordinary-runtime-assembly.js";
import {ordinaryStoreCases} from "./ordinary-store-cases.ts";

/** Contract suite of agent-runtime/ordinary/store r1; the fake and every store implementation must pass it. */
export const ordinaryStoreSuite = contractSuite(OrdinaryStore, ordinaryStoreCases);
