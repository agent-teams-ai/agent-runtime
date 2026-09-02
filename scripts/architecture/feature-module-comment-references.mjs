const LINE_SEPARATOR = /\r\n|[\n\r\u2028\u2029]/u;
const lineAt = (source, offset) => source.slice(0, Math.max(0, offset ?? 0)).split(LINE_SEPARATOR).length;
const horizontal = (character) => character === " " || character === "\t";
const lineBreak = (character) => ["\r", "\n", "\u2028", "\u2029"].includes(character);
const whitespace = (character) => horizontal(character) || lineBreak(character);
const triviaWhitespace = (character) => Boolean(character) && /\s/u.test(character);
const nameCharacter = (character) => Boolean(character) && (
  character >= "A" && character <= "Z"
  || character >= "a" && character <= "z"
  || character >= "0" && character <= "9"
  || ["$", "-", "_"].includes(character)
);
const skip = (source, index, predicate, end = source.length) => {
  while (index < end && predicate(source[index])) {index += 1;}
  return index;
};
const wordAt = (source, index, word) => source.startsWith(word, index)
  && !nameCharacter(source[index - 1])
  && !nameCharacter(source[index + word.length]);

const commentRange = (comment) => {
  const start = comment?.start ?? comment?.span?.start;
  const end = comment?.end ?? comment?.span?.end;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start ? { end, start } : undefined;
};
const record = ({ line, specifier, syntax, nonliteral = false }) => ({
  kind: "type", line, nonliteral, specifier, syntax,
});

const readQuoted = (source, index, end = source.length) => {
  const quote = source[index];
  if (!["\"", "'"].includes(quote)) {return { invalid: true, next: index };}
  let value = "", escaped = false;
  for (index += 1; index < end; index += 1) {
    if (source[index] === quote) {return { escaped, next: index + 1, value };}
    if (source[index] === "\\" || source[index] === "\r" || source[index] === "\n") {escaped = true;}
    value += source[index];
  }
  return { invalid: true, next: end };
};

const readName = (source, index, end = source.length) => {
  const start = index;
  while (index < end && nameCharacter(source[index])) {index += 1;}
  return { name: source.slice(start, index), next: index };
};

const tripleSlashRecord = (raw, line) => {
  if (!raw.startsWith("///")) {return;}
  let index = skip(raw, 3, horizontal);
  if (raw.slice(index, index + 10).toLowerCase() !== "<reference" || !horizontal(raw[index + 10])) {return;}
  index += 10;
  const close = raw.indexOf("/>", index);
  if (close < 0) {return;}
  const attribute = (wanted) => {
    for (let cursor = index; cursor < close; cursor += 1) {
      if (!whitespace(raw[cursor])) {continue;}
      cursor = skip(raw, cursor, whitespace, close);
      if (raw.slice(cursor, cursor + wanted.length).toLowerCase() !== wanted) {continue;}
      let next = skip(raw, cursor + wanted.length, horizontal, close);
      if (raw[next] !== "=") {continue;}
      next = skip(raw, next + 1, horizontal, close);
      const quoted = readQuoted(raw, next, close);
      if (!quoted.invalid) {return quoted;}
    }
  };
  if (attribute("no-default-lib")?.value === "true") {return;}
  const selected = ["types", "lib", "path"].map((name) => ({ name, quoted: attribute(name) }))
    .find(({ quoted }) => quoted);
  if (!selected) {return record({ line, syntax: "triple-slash-reference", nonliteral: true });}
  const { name, quoted } = selected;
  return quoted.value
    ? record({ line, specifier: quoted.value, syntax: `triple-slash-${name}` })
    : record({ line, syntax: `triple-slash-${name}`, nonliteral: true });
};

const TYPE_TAGS = new Set([
  "arg", "argument", "augments", "enum", "extends", "implements", "param", "prop", "property",
  "return", "returns", "satisfies", "this", "throws", "typedef",
]);
const OPTIONAL_BRACE_TYPE_TAGS = new Set(["type"]);

const typeExpressionEnd = (raw, open) => {
  let depth = 0, quote;
  for (let index = open; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === "\\") {index += 1;}
      else if (character === quote) {quote = undefined;}
      continue;
    }
    if (["\"", "'"].includes(character)) {quote = character; continue;}
    if (character === "{") {depth += 1;}
    if (character === "}" && --depth === 0) {return index;}
  }
  return raw.length;
};

const importTypeRecords = ({ begin, end, raw, source, start }) => {
  const records = [];
  for (let index = begin; index < end; index += 1) {
    if (["\"", "'"].includes(raw[index])) {index = readQuoted(raw, index, end).next - 1; continue;}
    if (!wordAt(raw, index, "import")) {continue;}
    let next = skip(raw, index + 6, whitespace, end);
    if (raw[next] !== "(") {continue;}
    next = skip(raw, next + 1, whitespace, end);
    const quoted = readQuoted(raw, next, end);
    next = skip(raw, quoted.next, whitespace, end);
    const valid = !quoted.invalid && !quoted.escaped && Boolean(quoted.value) && raw[next] === ")";
    records.push(record({
      line: lineAt(source, start + index),
      nonliteral: !valid,
      specifier: valid ? quoted.value : undefined,
      syntax: "jsdoc-import-type",
    }));
  }
  return records;
};

const importTagRecord = ({ contentStart, lineEnd, raw, source, start, tagStart }) => {
  let index = skip(raw, contentStart, horizontal, lineEnd);
  if (wordAt(raw, index, "type")) {index = skip(raw, index + 4, horizontal, lineEnd);}
  const bindingStart = index;
  let from = -1;
  for (; index < lineEnd; index += 1) {if (wordAt(raw, index, "from")) {from = index;}}
  let valid = from > bindingStart && raw.slice(bindingStart, from).trim();
  index = valid ? skip(raw, from + 4, horizontal, lineEnd) : lineEnd;
  const quoted = readQuoted(raw, index, lineEnd);
  index = skip(raw, quoted.next, whitespace, lineEnd);
  if (raw[index] === ";") {index = skip(raw, index + 1, whitespace, lineEnd);}
  if (raw.startsWith("*/", index)) {index = skip(raw, index + 2, whitespace, lineEnd);}
  valid = Boolean(valid && !quoted.invalid && !quoted.escaped && quoted.value && index === lineEnd);
  return record({
    line: lineAt(source, start + tagStart),
    nonliteral: !valid,
    specifier: valid ? quoted.value : undefined,
    syntax: "jsdoc-import-tag",
  });
};

const jsdocRecords = (raw, start, source) => {
  const records = [];
  let lineStart = 3;
  while (lineStart < raw.length) {
    let lineEnd = lineStart;
    while (lineEnd < raw.length && !lineBreak(raw[lineEnd])) {lineEnd += 1;}
    let index = skip(raw, lineStart, horizontal, lineEnd);
    if (raw[index] === "*") {index = skip(raw, index + 1, horizontal, lineEnd);}
    if (raw[index] === "@") {
      const tagStart = index, parsed = readName(raw, index + 1, lineEnd), tag = parsed.name;
      if (TYPE_TAGS.has(tag) || tag === "template") {
        const open = skip(raw, parsed.next, horizontal, lineEnd);
        if (raw[open] === "{") {
          records.push(...importTypeRecords({ begin: open + 1, end: typeExpressionEnd(raw, open), raw, source, start }));
        }
      } else if (OPTIONAL_BRACE_TYPE_TAGS.has(tag)) {
        const open = skip(raw, parsed.next, horizontal, lineEnd);
        const begin = raw[open] === "{" ? open + 1 : open;
        const end = raw[open] === "{" ? typeExpressionEnd(raw, open) : lineEnd;
        records.push(...importTypeRecords({ begin, end, raw, source, start }));
      } else if (tag === "import") {
        records.push(importTagRecord({ contentStart: parsed.next, lineEnd, raw, source, start, tagStart }));
      }
    }
    lineStart = lineEnd + (raw[lineEnd] === "\r" && raw[lineEnd + 1] === "\n" ? 2 : 1);
  }
  return records;
};

const JSDOC_HOST_TYPES = new Set([
  "ArrowFunctionExpression", "BreakStatement", "CallSignature", "ClassDeclaration", "ClassExpression",
  "Constructor", "ConstructorType", "ConstructSignature", "ContinueStatement", "DebuggerStatement",
  "DoWhileStatement", "EmptyStatement", "EnumDeclaration", "EnumMember", "ExportAllDeclaration",
  "ExportDefaultDeclaration", "ExportNamedDeclaration", "ExpressionStatement", "ForInStatement",
  "ForOfStatement", "ForStatement", "FunctionDeclaration", "FunctionExpression", "FunctionType",
  "IfStatement", "ImportDeclaration", "ImportExpression", "JSXAttribute", "LabeledStatement",
  "MethodDefinition", "MethodSignature", "ModuleDeclaration", "NamedTupleMember", "NamespaceExportDeclaration",
  "ObjectMethod", "ObjectProperty", "ParenthesizedExpression", "PropertyDefinition", "PropertySignature",
  "ReturnStatement", "StaticBlock", "SwitchStatement", "ThrowStatement", "TryStatement", "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration", "TSConstructorType", "TSEnumDeclaration", "TSEnumMember",
  "TSDeclareFunction", "TSFunctionType", "TSImportEqualsDeclaration", "TSInterfaceDeclaration", "TSMethodSignature",
  "TSModuleDeclaration", "TSPropertySignature", "TSTypeAliasDeclaration", "TSTypeParameter",
  "VariableDeclaration", "WhileStatement", "WithStatement",
]);

const childNodes = (node) => Object.entries(node ?? {}).flatMap(([key, value]) => {
  if (["comments", "errors", "parent", "tokens"].includes(key)) {return [];}
  if (Array.isArray(value)) {return value.filter((item) => item && typeof item === "object" && typeof item.type === "string");}
  return value && typeof value === "object" && typeof value.type === "string" ? [value] : [];
});

const attachmentIndex = (program, source, comments) => {
  const hosts = new Set(), topLevelRanges = [];
  const visit = (node, mayAttach = true) => {
    if (!node || typeof node !== "object") {return;}
    if (mayAttach && JSDOC_HOST_TYPES.has(node.type) && Number.isInteger(node.start)) {hosts.add(node.start);}
    for (const child of childNodes(node)) {
      const nestedExportDeclaration = child === node.declaration
        && ["ExportDefaultDeclaration", "ExportNamedDeclaration"].includes(node.type);
      visit(child, !nestedExportDeclaration);
    }
  };
  for (const node of program.body ?? []) {
    if (Number.isInteger(node.start) && Number.isInteger(node.end)) {topLevelRanges.push({ end: node.end, start: node.start });}
    visit(node);
  }
  const commentRanges = new Map((comments ?? []).map(commentRange).filter(Boolean).map((range) => [range.start, range]));
  const triviaEnd = (range) => {
    let cursor = range.end;
    while (cursor < source.length) {
      cursor = skip(source, cursor, triviaWhitespace);
      const following = commentRanges.get(cursor);
      if (!following) {break;}
      cursor = following.end;
    }
    return cursor;
  };
  const topLevelAtEof = (range) => !topLevelRanges.some(({ end, start }) => start < range.start && range.end < end);
  return (range) => {
    const next = triviaEnd(range);
    return hosts.has(next) || next === source.length && topLevelAtEof(range);
  };
};

export const commentImportRecords = (program, source, comments) => {
  const boundary = Math.min(program.body?.[0]?.start ?? source.length, program.directives?.[0]?.start ?? source.length);
  const records = [], isAttachedJSDoc = attachmentIndex(program, source, comments);
  for (const comment of comments ?? []) {
    const range = commentRange(comment);
    if (!range) {continue;}
    const raw = source.slice(range.start, range.end);
    if (range.start < boundary && comment.type === "Line" && raw.startsWith("///")) {
      const reference = tripleSlashRecord(raw, lineAt(source, range.start));
      if (reference) {records.push(reference);}
    }
    if (comment.type === "Block" && raw.startsWith("/**") && isAttachedJSDoc(range)) {
      records.push(...jsdocRecords(raw, range.start, source));
    }
  }
  return records;
};
