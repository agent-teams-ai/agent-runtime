import assert from "node:assert/strict";
import test from "node:test";
import {createDarwinContainedTurnDeployment} from "../../dist/composition.js";

test("publishes the fixed Darwin deployment factory from the package composition API", () => {
  assert.equal(typeof createDarwinContainedTurnDeployment, "function");
  assert.throws(() => createDarwinContainedTurnDeployment(null as never), /Invalid Darwin deployment input/u);
});
