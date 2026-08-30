const MODULE_SPECIFIERS = new Set(["module", "node:module"]);
const MAX_ALIAS_DEPTH = 8;
const MAX_IMPORT_RECORDS = 2048;
const CAPABILITY = Object.freeze({
  factory: "factory",
  loader: "loader",
  builtinFactory: "builtin-factory",
  unknownBuiltinFactory: "unknown-builtin-factory",
  metaObject: "meta-object",
  moduleObject: "module-object",
  namespace: "namespace",
  processObject: "process-object",
  none: "none",
  unknownFactory: "unknown-factory",
  unknownLoader: "unknown-loader",
});

const lineAt = (source, offset) => source.slice(0, Math.max(0, offset ?? 0)).split("\n").length;

export const literalValue = (node) => {
  if (!node || typeof node !== "object") {return;}
  if (typeof node.value === "string") {return node.value;}
  if (node.type === "TemplateLiteral" && !node.expressions?.length && node.quasis?.length === 1) {
    return node.quasis[0].value?.cooked ?? node.quasis[0].value?.raw;
  }
  if (typeof node.raw === "string" && /^(['"]).*\1$/s.test(node.raw)) {return node.raw.slice(1, -1);}
  if (node.type === "TSLiteralType") {return literalValue(node.literal);}
};

export const walkAst = (node, visitor) => {
  if (!node || typeof node !== "object") {return;}
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (["parent", "comments", "tokens", "errors"].includes(key)) {continue;}
    if (Array.isArray(value)) {value.forEach((item) => walkAst(item, visitor));}
    else if (value && typeof value === "object" && typeof value.type === "string") {walkAst(value, visitor);}
  }
};

const named = (node, name) => node?.type === "Identifier" && node.name === name;
const unwrap = (node) => node?.type === "AwaitExpression" ? unwrap(node.argument)
  : ["ChainExpression", "ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]
    .includes(node?.type) ? unwrap(node.expression) : node;
const staticPropertyName = (node) => {
  if (!node) {return;}
  if (node.computed) {return literalValue(node.property ?? node.key);}
  return node.property?.name ?? node.key?.name ?? literalValue(node.property ?? node.key);
};
const member = (node, object, property) => node?.type === "MemberExpression"
  && named(node.object, object)
  && staticPropertyName(node) === property;
const bindingName = (node) => node?.type === "Identifier" ? node.name
  : node?.type === "AssignmentPattern" && node.left?.type === "Identifier" ? node.left.name : undefined;
const nestedBindingNames = (node) => {
  if (!node) {return [];}
  const direct = bindingName(node);
  if (direct) {return [direct];}
  if (node.type === "AssignmentPattern") {return nestedBindingNames(node.left);}
  if (node.type === "RestElement") {return nestedBindingNames(node.argument);}
  if (node.type === "TSParameterProperty") {return nestedBindingNames(node.parameter);}
  if (node.type === "ObjectPattern") {return node.properties.flatMap((property) => nestedBindingNames(property.value ?? property.argument));}
  if (node.type === "ArrayPattern") {return node.elements.flatMap((element) => nestedBindingNames(element));}
  return [];
};

const safeCreateRequireBase = (node, isBound, isMetaPropertySafe) => {
  const candidate = unwrap(node);
  if (named(candidate, "__filename")) {return !isBound(candidate);}
  const property = staticPropertyName(candidate);
  if (candidate?.type !== "MemberExpression" || !["filename", "url"].includes(property) || !isMetaPropertySafe(property)) {return false;}
  const object = unwrap(candidate.object);
  return object?.type === "MetaProperty" && object.meta?.name === "import" && object.property?.name === "meta";
};

const recordImportSeeds = (node, addSeed) => {
  if (node.type === "TSImportEqualsDeclaration"
    && node.id?.type === "Identifier"
    && node.moduleReference?.type === "TSExternalModuleReference"
    && MODULE_SPECIFIERS.has(literalValue(node.moduleReference.expression))) {
    addSeed(node.id.name, CAPABILITY.namespace);
    return;
  }
  if (node.type !== "ImportDeclaration" || !MODULE_SPECIFIERS.has(literalValue(node.source))) {return;}
  for (const specifier of node.specifiers ?? []) {
    const local = specifier.local?.name;
    if (!local) {continue;}
    if (["ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(specifier.type)) {addSeed(local, CAPABILITY.namespace); continue;}
    const imported = specifier.imported?.name ?? specifier.imported?.value;
    if (["default", "Module"].includes(imported)) {addSeed(local, CAPABILITY.namespace);}
    if (imported === "createRequire") {addSeed(local, CAPABILITY.factory);}
  }
};

const memberExpression = (object, property) => ({
  computed: Boolean(property.computed),
  object,
  optional: false,
  property: property.key,
  type: "MemberExpression",
});

const defaultedExpression = (source, fallback) => ({ left: source, operator: "??", right: fallback, type: "LogicalExpression" });

const recordPatternDefinitions = (pattern, source, addDefinition) => {
  if (!pattern) {return;}
  if (pattern.type === "Identifier") {addDefinition(pattern.name, { expression: source, kind: "expression" }); return;}
  if (pattern.type === "AssignmentPattern") {
    recordPatternDefinitions(pattern.left, defaultedExpression(source, pattern.right), addDefinition);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) {
      if (property.type === "RestElement") {
        for (const name of nestedBindingNames(property.argument)) {addDefinition(name, { kind: "rest", source });}
      } else {recordPatternDefinitions(property.value, memberExpression(source, property), addDefinition);}
    }
    return;
  }
  for (const name of nestedBindingNames(pattern)) {addDefinition(name, { kind: "unsupported-pattern", source });}
};

const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"]);
const BLOCK_SCOPE_TYPES = new Set(["BlockStatement", "ForInStatement", "ForOfStatement", "ForStatement", "SwitchStatement"]);
const childNodes = (node, omitted = new Set()) => Object.entries(node).flatMap(([key, value]) => {
  if (omitted.has(key) || ["parent", "comments", "tokens", "errors"].includes(key)) {return [];}
  if (Array.isArray(value)) {return value.filter((item) => item && typeof item === "object" && typeof item.type === "string");}
  return value && typeof value === "object" && typeof value.type === "string" ? [value] : [];
});
const createScope = (parent, type) => ({ bindings: new Map(), parent, type });
const ensureBinding = (scope, name) => {
  if (!name) {return;}
  const binding = scope.bindings.get(name) ?? { assigned: false, definitions: [], seeds: [] };
  scope.bindings.set(name, binding);
  return binding;
};
const bindPattern = (scope, pattern) => {
  for (const name of nestedBindingNames(pattern)) {ensureBinding(scope, name);}
};
const functionScope = (scope) => ["function", "namespace", "program", "static-block"].includes(scope.type) ? scope : functionScope(scope.parent);
const lookupBinding = (scope, name) => scope?.bindings.has(name) ? scope.bindings.get(name)
  : scope?.parent ? lookupBinding(scope.parent, name) : undefined;
const simpleParameter = (node) => node?.type === "Identifier"
  || node?.type === "TSParameterProperty" && node.parameter?.type === "Identifier";

const collectCapabilities = (program) => {
  const globalAssignments = new Set(), nodeScopes = new WeakMap(), root = createScope(undefined, "program");
  const visitChildren = (node, scope, omitted) => {
    for (const child of childNodes(node, omitted)) {visit(child, scope);}
  };
  const visitFunction = (node, scope) => {
    if (node.type === "FunctionDeclaration") {bindPattern(scope, node.id);}
    const local = createScope(scope, "function");
    if (node.type === "FunctionExpression") {bindPattern(local, node.id);}
    const splitParameters = !(node.params ?? []).every(simpleParameter);
    const parameterScope = splitParameters ? createScope(local, "parameters") : local;
    for (const parameter of node.params ?? []) {bindPattern(parameterScope, parameter);}
    const addParameterDefinition = (name, definition) => ensureBinding(parameterScope, name).definitions.push(definition);
    for (const parameter of node.params ?? []) {recordPatternDefinitions(parameter, undefined, addParameterDefinition);}
    for (const parameter of node.params ?? []) {visit(parameter, parameterScope);}
    const bodyScope = splitParameters ? createScope(parameterScope, "function") : local;
    if (node.body) {visit(node.body, bodyScope);}
    visitChildren(node, local, new Set(["id", "params", "body"]));
  };
  const visitVariableDeclaration = (node, scope) => {
    const bindingScope = node.kind === "var" ? functionScope(scope) : scope;
    for (const declaration of node.declarations ?? []) {
      bindPattern(bindingScope, declaration.id);
      const addDefinition = (name, definition) => ensureBinding(bindingScope, name).definitions.push(definition);
      if (declaration.id?.type === "Identifier") {addDefinition(declaration.id.name, { expression: declaration.init, kind: "expression" });}
      else {recordPatternDefinitions(declaration.id, declaration.init, addDefinition);}
    }
    visitChildren(node, scope);
  };
  const visit = (node, scope) => {
    if (!node || typeof node !== "object") {return;}
    nodeScopes.set(node, scope);
    if (FUNCTION_TYPES.has(node.type)) {visitFunction(node, scope); return;}
    if (node.type === "StaticBlock") {
      const local = createScope(scope, "static-block");
      nodeScopes.set(node, local); visitChildren(node, local); return;
    }
    if (node.type === "TSModuleDeclaration") {
      bindPattern(scope, node.id);
      const local = createScope(scope, "namespace");
      nodeScopes.set(node, local); visitChildren(node, local, new Set(["id"])); return;
    }
    if (BLOCK_SCOPE_TYPES.has(node.type)) {
      const local = createScope(scope, "block");
      nodeScopes.set(node, local); visitChildren(node, local); return;
    }
    if (node.type === "CatchClause") {
      const local = createScope(scope, "block");
      bindPattern(local, node.param); nodeScopes.set(node, local); visitChildren(node, local); return;
    }
    if (["ClassDeclaration", "ClassExpression"].includes(node.type)) {
      if (node.type === "ClassDeclaration") {bindPattern(scope, node.id);}
      const local = createScope(scope, "block");
      bindPattern(local, node.id); visitChildren(node, local); return;
    }
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers ?? []) {bindPattern(scope, specifier.local);}
      recordImportSeeds(node, (name, seed) => ensureBinding(scope, name).seeds.push(seed));
    }
    if (node.type === "TSImportEqualsDeclaration") {
      bindPattern(scope, node.id);
      recordImportSeeds(node, (name, seed) => ensureBinding(scope, name).seeds.push(seed));
    }
    if (node.type === "VariableDeclaration") {visitVariableDeclaration(node, scope); return;}
    visitChildren(node, scope);
  };
  visitChildren(program, root);
  walkAst(program, (node) => {
    const target = node.type === "AssignmentExpression" ? node.left
      : node.type === "UpdateExpression" ? node.argument : undefined;
    for (const name of nestedBindingNames(target)) {
      const binding = lookupBinding(nodeScopes.get(target) ?? root, name);
      if (binding) {binding.assigned = true;}
      else if (["__filename", "module", "require"].includes(name)) {globalAssignments.add(name);}
    }
  });
  return { globalAssignments, lookup: (node, name) => lookupBinding(nodeScopes.get(node) ?? root, name) };
};

const isUnknown = (kind) => [CAPABILITY.unknownFactory, CAPABILITY.unknownLoader].includes(kind);
const isCapability = (kind) => [
  CAPABILITY.builtinFactory,
  CAPABILITY.factory,
  CAPABILITY.loader,
  CAPABILITY.moduleObject,
  CAPABILITY.namespace,
  CAPABILITY.unknownFactory,
  CAPABILITY.unknownBuiltinFactory,
  CAPABILITY.unknownLoader,
].includes(kind);
const objectValues = (object) => object.properties?.flatMap((property) => property.type === "SpreadElement"
  ? [property.argument]
  : property.computed ? [property.key, property.value] : [property.value]);
const namespaceMemberCapability = (candidate, property) => {
  if (property === "createRequire") {return CAPABILITY.factory;}
  if (property === "_load") {return CAPABILITY.loader;}
  if (property === "prototype") {return CAPABILITY.moduleObject;}
  if (["default", "Module"].includes(property)) {return CAPABILITY.namespace;}
  return candidate.computed && property === undefined ? CAPABILITY.unknownLoader : CAPABILITY.none;
};
const moduleObjectMemberCapability = (candidate, property) => {
  if (property === "constructor") {return CAPABILITY.namespace;}
  if (property === "parent") {return CAPABILITY.moduleObject;}
  if (property === "require") {return CAPABILITY.loader;}
  return candidate.computed && property === undefined ? CAPABILITY.unknownLoader : CAPABILITY.none;
};
const callableMemberCapability = (candidate, property, unknownCapability) => (
  candidate.computed && property === undefined || ["apply", "bind", "call"].includes(property)
) ? unknownCapability : CAPABILITY.none;

const mutationTarget = (node) => node.type === "AssignmentExpression" ? node.left
  : node.type === "UpdateExpression" ? node.argument
    : node.type === "UnaryExpression" && node.operator === "delete" ? node.argument : undefined;

const terminalCapability = (candidate, resolveName, classify, depth, stack) => {
  switch (candidate.type) {
    case "Identifier": return resolveName(candidate, depth, stack);
    case "ImportExpression": return MODULE_SPECIFIERS.has(literalValue(candidate.source)) ? CAPABILITY.namespace : CAPABILITY.none;
    case "MetaProperty": return candidate.meta?.name === "import" && candidate.property?.name === "meta"
      ? CAPABILITY.metaObject : CAPABILITY.none;
    case "SequenceExpression": return classify(candidate.expressions?.at(-1), depth, stack);
    default: return;
  }
};

const sourcedDefinitionCapability = (sourceKind, definition) => {
  const staticProperty = definition.kind === "property" && !definition.dynamic, property = definition.key;
  if (sourceKind === CAPABILITY.namespace && staticProperty) {
    if (property === "createRequire") {return CAPABILITY.factory;}
    if (["default", "Module"].includes(property)) {return CAPABILITY.namespace;}
    return CAPABILITY.none;
  }
  if (sourceKind === CAPABILITY.processObject) {
    if (staticProperty) {return property === "getBuiltinModule" ? CAPABILITY.builtinFactory : CAPABILITY.none;}
    return CAPABILITY.unknownBuiltinFactory;
  }
  if (sourceKind === CAPABILITY.namespace) {return CAPABILITY.unknownFactory;}
  if (sourceKind === CAPABILITY.moduleObject && staticProperty) {
    if (property === "constructor") {return CAPABILITY.namespace;}
    if (property === "require") {return CAPABILITY.loader;}
    return CAPABILITY.none;
  }
  if (sourceKind === CAPABILITY.moduleObject || sourceKind === CAPABILITY.loader) {return CAPABILITY.unknownLoader;}
  if (sourceKind === CAPABILITY.factory) {return CAPABILITY.unknownFactory;}
  if (isUnknown(sourceKind) || sourceKind === CAPABILITY.unknownBuiltinFactory) {return sourceKind;}
  return CAPABILITY.none;
};

const createCapabilityAnalysis = (program) => {
  const collected = collectCapabilities(program);
  const unsafeMetaProperties = new Set();
  let classify;
  const resolveDefinition = (definition, depth, stack) => {
    const sourceKind = definition.source ? classify(definition.source, depth + 1, stack) : CAPABILITY.none;
    if (definition.kind === "expression") {return classify(definition.expression, depth + 1, stack);}
    return sourcedDefinitionCapability(sourceKind, definition);
  };
  const resolveBinding = (binding, depth, stack) => {
    if (stack.has(binding)) {return CAPABILITY.none;}
    if (depth > MAX_ALIAS_DEPTH) {
      const underlying = resolveBinding(binding, Number.NEGATIVE_INFINITY, new Set());
      return isCapability(underlying) ? CAPABILITY.unknownLoader : CAPABILITY.none;
    }
    const nextStack = new Set(stack).add(binding), definitions = binding.definitions;
    if (binding.seeds.length && definitions.length || binding.seeds.length > 1) {return CAPABILITY.unknownLoader;}
    if (binding.seeds.length === 1) {return binding.assigned ? CAPABILITY.unknownLoader : binding.seeds[0];}
    if (!definitions.length) {return CAPABILITY.none;}
    const resolved = definitions.map((definition) => resolveDefinition(definition, depth, nextStack));
    const capable = resolved.filter(isCapability);
    if (!capable.length) {
      const metaObjects = resolved.filter((kind) => kind === CAPABILITY.metaObject);
      return metaObjects.length && !binding.assigned && resolved.every((kind) => [CAPABILITY.metaObject, CAPABILITY.none].includes(kind))
        ? CAPABILITY.metaObject : CAPABILITY.none;
    }
    if (binding.assigned) {return CAPABILITY.unknownLoader;}
    if (definitions.length === 1) {return capable[0];}
    return CAPABILITY.unknownLoader;
  };
  const resolveName = (node, depth = 0, stack = new Set()) => {
    const binding = collected.lookup(node, node.name);
    if (binding) {return resolveBinding(binding, depth, stack);}
    if (collected.globalAssignments.has(node.name)) {return CAPABILITY.unknownLoader;}
    if (node.name === "module") {return CAPABILITY.moduleObject;}
    if (node.name === "process") {return CAPABILITY.processObject;}
    return node.name === "require" ? CAPABILITY.loader : CAPABILITY.none;
  };
  const combinedCapability = (expressions, depth, stack) => {
    const kinds = (expressions ?? [])
      .map((expression) => classify(expression, depth, stack))
      .filter(isCapability);
    if (!kinds.length) {return CAPABILITY.none;}
    return kinds.every((kind) => [CAPABILITY.factory, CAPABILITY.unknownFactory].includes(kind))
      ? CAPABILITY.unknownFactory : CAPABILITY.unknownLoader;
  };
  const classifyCall = (candidate, depth, stack) => {
    const calleeKind = classify(candidate.callee, depth, stack);
    if (calleeKind === CAPABILITY.builtinFactory) {
      const specifier = literalValue(candidate.arguments?.[0]);
      if (MODULE_SPECIFIERS.has(specifier) && candidate.arguments?.length === 1) {return CAPABILITY.namespace;}
      return specifier === undefined ? CAPABILITY.unknownLoader : CAPABILITY.none;
    }
    if (calleeKind === CAPABILITY.unknownBuiltinFactory) {return CAPABILITY.unknownLoader;}
    if (calleeKind === CAPABILITY.loader && MODULE_SPECIFIERS.has(literalValue(candidate.arguments?.[0]))) {return CAPABILITY.namespace;}
    if (calleeKind === CAPABILITY.namespace) {return CAPABILITY.moduleObject;}
    if (calleeKind === CAPABILITY.factory) {
      return safeCreateRequireBase(
        candidate.arguments?.[0],
        (base) => Boolean(collected.lookup(base, base.name) || collected.globalAssignments.has(base.name)),
        (property) => !unsafeMetaProperties.has(property),
      )
        && candidate.arguments?.length === 1
        ? CAPABILITY.loader : CAPABILITY.unknownLoader;
    }
    return calleeKind === CAPABILITY.unknownFactory ? CAPABILITY.unknownLoader : CAPABILITY.none;
  };
  const classifyMember = (candidate, depth, stack) => {
    const objectKind = classify(candidate.object, depth, stack), property = staticPropertyName(candidate);
    if (objectKind === CAPABILITY.processObject) {
      if (property === "getBuiltinModule") {return CAPABILITY.builtinFactory;}
      return candidate.computed && property === undefined ? CAPABILITY.unknownBuiltinFactory : CAPABILITY.none;
    }
    if (objectKind === CAPABILITY.namespace) {return namespaceMemberCapability(candidate, property);}
    if (objectKind === CAPABILITY.moduleObject) {return moduleObjectMemberCapability(candidate, property);}
    if (objectKind === CAPABILITY.factory) {return callableMemberCapability(candidate, property, CAPABILITY.unknownFactory);}
    if (objectKind === CAPABILITY.builtinFactory) {return callableMemberCapability(candidate, property, CAPABILITY.unknownBuiltinFactory);}
    if (objectKind === CAPABILITY.loader) {
      if (property === "main") {return CAPABILITY.moduleObject;}
      if (property === "resolve") {return CAPABILITY.loader;}
      return callableMemberCapability(candidate, property, CAPABILITY.unknownLoader);
    }
    return isUnknown(objectKind) ? CAPABILITY.unknownLoader : CAPABILITY.none;
  };
  classify = (node, depth = 0, stack = new Set()) => {
    const candidate = unwrap(node);
    if (!candidate) {return CAPABILITY.none;}
    const terminal = terminalCapability(candidate, resolveName, classify, depth, stack);
    if (terminal !== undefined) {return terminal;}
    switch (candidate.type) {
      case "ConditionalExpression": return combinedCapability([candidate.consequent, candidate.alternate], depth, stack);
      case "LogicalExpression": return combinedCapability([candidate.left, candidate.right], depth, stack);
      case "ArrayExpression": return combinedCapability(candidate.elements, depth, stack);
      case "ObjectExpression": return combinedCapability(objectValues(candidate), depth, stack);
      case "ArrowFunctionExpression": return candidate.expression ? combinedCapability([candidate.body], depth, stack) : CAPABILITY.none;
      case "CallExpression":
      case "NewExpression": return classifyCall(candidate, depth, stack);
      case "MemberExpression": return classifyMember(candidate, depth, stack);
      default: return CAPABILITY.none;
    }
  };
  walkAst(program, (node) => {
    const target = unwrap(mutationTarget(node));
    if (target?.type !== "MemberExpression" || classify(target.object) !== CAPABILITY.metaObject) {return;}
    const property = staticPropertyName(target);
    if (["filename", "url"].includes(property)) {unsafeMetaProperties.add(property);}
    else if (target.computed && property === undefined) {unsafeMetaProperties.add("filename"); unsafeMetaProperties.add("url");}
  });
  return {
    classify,
    isBound: (node, name) => Boolean(collected.lookup(node, name)),
    unsafeMetaProperties,
  };
};

const makeRecord = ({ node, specifierNode, kind, syntax, source, nonliteral = false }) => ({
  specifier: literalValue(specifierNode), kind, syntax, nonliteral, line: lineAt(source, specifierNode?.start ?? node.start),
});
const typeOnly = (node, property) => node[property] === "type"
  || Boolean(node.specifiers?.length) && node.specifiers.every((specifier) => specifier[property] === "type");

const knownLoadingSyntax = (callee) => {
  if (named(callee, "require")) {return "require";}
  if (member(callee, "require", "resolve")) {return "require-resolve";}
  if (member(callee, "module", "require")) {return "module-require";}
  return "create-require";
};

const readImportRecord = (node, source, analysis) => {
  if (node.type === "ImportDeclaration") {return makeRecord({ node, specifierNode: node.source, kind: typeOnly(node, "importKind") ? "type" : "runtime", syntax: "import", source });}
  if (node.type === "ExportNamedDeclaration" && node.source) {return makeRecord({ node, specifierNode: node.source, kind: typeOnly(node, "exportKind") ? "type" : "runtime", syntax: "re-export", source });}
  if (node.type === "ExportAllDeclaration") {return makeRecord({ node, specifierNode: node.source, kind: node.exportKind === "type" ? "type" : "runtime", syntax: "re-export", source });}
  if (node.type === "ImportExpression") {return makeRecord({ node, specifierNode: node.source, kind: "runtime", syntax: "dynamic-import", source, nonliteral: literalValue(node.source) === undefined });}
  if (node.type === "TSImportType") {const target = node.source ?? node.argument; return makeRecord({ node, specifierNode: target, kind: "type", syntax: "import-type", source, nonliteral: literalValue(target) === undefined });}
  if (node.type === "TSImportEqualsDeclaration" && node.moduleReference?.type === "TSExternalModuleReference") {
    const target = node.moduleReference.expression;
    return makeRecord({ node, specifierNode: target, kind: node.importKind === "type" ? "type" : "runtime", syntax: "import-equals", source, nonliteral: literalValue(target) === undefined });
  }
  if (!["CallExpression", "NewExpression"].includes(node.type)) {return;}
  const calleeKind = analysis.classify(node.callee);
  if (calleeKind === CAPABILITY.loader) {
    const target = node.arguments?.[0];
    return makeRecord({ node, specifierNode: target, kind: "runtime", syntax: knownLoadingSyntax(node.callee), source, nonliteral: literalValue(target) === undefined });
  }
  if (calleeKind === CAPABILITY.unknownLoader) {
    return makeRecord({ node, specifierNode: node.arguments?.[0], kind: "runtime", syntax: "computed-loader", source, nonliteral: true });
  }
};

const directEscapeTarget = (node, analysis) => {
  if (node.type === "AssignmentExpression" && isCapability(analysis.classify(node.right))) {return node.right;}
  if (["ReturnStatement", "ThrowStatement", "YieldExpression"].includes(node.type)
    && isCapability(analysis.classify(node.argument))) {return node.argument;}
  if (["AccessorProperty", "PropertyDefinition"].includes(node.type)
    && isCapability(analysis.classify(node.value))) {return node.value;}
  if (node.type === "ExportDefaultDeclaration" && isCapability(analysis.classify(node.declaration))) {return node.declaration;}
};

const escapeRecord = (node, source, analysis) => {
  if (node.type === "ExportNamedDeclaration" && MODULE_SPECIFIERS.has(literalValue(node.source))
    && node.specifiers?.some((specifier) => (specifier.local?.name ?? specifier.local?.value) === "createRequire")) {
    return makeRecord({ node, specifierNode: node.source, kind: "runtime", syntax: "loader-escape", source, nonliteral: true });
  }
  let target = directEscapeTarget(node, analysis);
  if (["CallExpression", "NewExpression"].includes(node.type)) {
    const calleeKind = analysis.classify(node.callee);
    if (![CAPABILITY.factory, CAPABILITY.unknownFactory].includes(calleeKind)) {
      target = node.arguments?.find((argument) => isCapability(analysis.classify(argument)));
    }
  }
  if (node.type === "ExportNamedDeclaration" && !node.source) {
    target = node.declaration?.declarations?.map((declaration) => declaration.init)
      .find((initial) => isCapability(analysis.classify(initial)))
      ?? node.specifiers?.map((specifier) => specifier.local).find((local) => isCapability(analysis.classify(local)));
  }
  if (!target) {return;}
  return makeRecord({ node, specifierNode: target, kind: "runtime", syntax: "loader-escape", source, nonliteral: true });
};

const mutationRecord = (node, source, analysis) => {
  const target = unwrap(mutationTarget(node));
  if (!target) {return;}
  const implicitFilename = named(target, "__filename") && !analysis.isBound(target, target.name);
  const metaProperty = target?.type === "MemberExpression" ? staticPropertyName(target) : undefined;
  const metaMember = target.type === "MemberExpression"
    && analysis.classify(target.object) === CAPABILITY.metaObject
    && (["filename", "url"].includes(metaProperty) || target.computed && metaProperty === undefined);
  if (!implicitFilename && !metaMember && !isCapability(analysis.classify(target))) {return;}
  return makeRecord({ node, specifierNode: target, kind: "runtime", syntax: "loader-mutation", source, nonliteral: true });
};

export const importRecords = (program, source) => {
  const analysis = createCapabilityAnalysis(program), records = [];
  let overflow = false;
  walkAst(program, (node) => {
    if (records.length >= MAX_IMPORT_RECORDS) {overflow = true; return;}
    const imported = readImportRecord(node, source, analysis), mutated = mutationRecord(node, source, analysis);
    const escaped = mutated ? undefined : escapeRecord(node, source, analysis);
    if (imported) {records.push(imported);}
    if (mutated) {records.push(mutated);}
    if (escaped) {records.push(escaped);}
  });
  const result = [...new Map(records.map((record) => [
    `${record.line}:${record.syntax}:${record.nonliteral ? "?" : record.specifier ?? "?"}`,
    record,
  ])).values()];
  result.overflow = overflow;
  return result;
};
