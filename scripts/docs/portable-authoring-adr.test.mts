import test from "node:test";
import { runPortableAuthoringScenario } from "./portable-authoring-test-support.mts";

test("portable authoring preserves runtime-adr", () => runPortableAuthoringScenario("runtime-adr"));
