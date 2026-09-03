import assert from "node:assert/strict";

import { parseSync } from "oxc-parser";

const FACTORY_NAME = "createContainedTurnFeatureFromProviderAccess";
const EXPECTED_PORTS = [
  "operationStore", "security", "providerAccess", "workspace", "artifacts", "custody", "provider",
];

export const containedTurnFactoryPortKeys = (source: string): string[] => {
  const parsed = parseSync("contained-turn-feature-composition.ts", source);
  assert.deepEqual(parsed.errors, [], "outer composition must parse without diagnostics");
  const declarations = parsed.program.body.flatMap(node =>
    node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration"
      ? node.declaration.declarations.filter(declaration =>
        declaration.id.type === "Identifier" && declaration.id.name === FACTORY_NAME,
      )
      : [],
  );
  assert.equal(declarations.length, 1, `expected exactly one exported ${FACTORY_NAME} factory`);
  const factory = declarations[0]?.init;
  assert.equal(factory?.type, "ArrowFunctionExpression", `${FACTORY_NAME} must remain an arrow function`);
  assert.equal(factory.body.type, "BlockStatement", `${FACTORY_NAME} must retain a block body`);
  const returns = factory.body.body.filter(statement => statement.type === "ReturnStatement");
  assert.equal(returns.length, 1, `${FACTORY_NAME} must contain exactly one direct return`);
  const featureCall = returns[0]?.argument;
  assert.equal(featureCall?.type, "CallExpression", `${FACTORY_NAME} must return a call`);
  assert.equal(featureCall.callee.type, "Identifier");
  assert.equal(featureCall.callee.name, "createContainedTurnFeature");
  assert.equal(featureCall.arguments.length, 1);
  const freezeCall = featureCall.arguments[0];
  assert.equal(freezeCall?.type, "CallExpression", "feature dependencies must be frozen");
  assert.equal(freezeCall.callee.type, "MemberExpression");
  assert.equal(freezeCall.callee.computed, false);
  assert.equal(freezeCall.callee.object.type, "Identifier");
  assert.equal(freezeCall.callee.object.name, "Object");
  assert.equal(freezeCall.callee.property.type, "Identifier");
  assert.equal(freezeCall.callee.property.name, "freeze");
  assert.equal(freezeCall.arguments.length, 1);
  const dependencies = freezeCall.arguments[0];
  assert.equal(dependencies?.type, "ObjectExpression", "frozen feature dependencies must be an object literal");
  const keys = dependencies.properties.map(property => {
    assert.equal(property.type, "Property", "feature dependencies cannot use spread properties");
    assert.equal(property.computed, false, "feature dependency keys cannot be computed");
    assert.equal(property.key.type, "Identifier", "feature dependency keys must be identifiers");
    return property.key.name;
  });
  assert.deepEqual(keys, EXPECTED_PORTS, "feature factory must supply the exact seven ports in order");
  return keys;
};
