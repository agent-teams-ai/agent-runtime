export const CHECKER_LIMITS = Object.freeze({
  configBytes: 4 * 1024 * 1024,
  configFiles: 256,
  diagnostics: 512,
  files: 4096,
  imports: 16384,
  renderedBytes: 256 * 1024,
  sourceBytes: 32 * 1024 * 1024,
  sourceFileBytes: 1024 * 1024,
  traversalDepth: 128,
  traversalEntries: 4096,
});

const MAX_OMITTED = 999999;
const encodedLength = (value) => Buffer.byteLength(value, "utf8");

export const escapedDiagnosticText = (value) => [...String(value)].map((character) => {
  const codePoint = character.codePointAt(0);
  const unsafe = codePoint <= 0x1F
    || codePoint >= 0x7F && codePoint <= 0x9F
    || codePoint === 0x61C
    || codePoint === 0x200E
    || codePoint === 0x200F
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint >= 0x202A && codePoint <= 0x202E
    || codePoint >= 0x2066 && codePoint <= 0x2069;
  return unsafe ? `\\u{${codePoint.toString(16).padStart(2, "0")}}` : character;
}).join("");

export const overflowIssue = (issue, resource, omitted = 1) => issue(
  "FM_CHECKER_OVERFLOW",
  "<checker>",
  1,
  `${resource} limit exceeded; omitted ${Math.min(MAX_OMITTED, Math.max(1, omitted))}${omitted > MAX_OMITTED ? "+" : ""} item(s)`,
);

export const createDiagnosticCollector = (issue, limit = CHECKER_LIMITS.diagnostics) => {
  const entries = [];
  let omitted = 0;
  return {
    add(candidates) {
      for (const candidate of candidates ?? []) {
        if (candidate.code === "FM_CHECKER_OVERFLOW") {
          const resource = String(candidate.message).match(/^(.*?) limit exceeded/u)?.[1] || "resource";
          this.overflow(resource); continue;
        }
        if (entries.length < limit) {entries.push(candidate);}
        else {omitted = Math.min(MAX_OMITTED + 1, omitted + 1);}
      }
    },
    push(...candidates) {this.add(candidates); return entries.length;},
    overflow(resource = "diagnostic", count = 1) {omitted = Math.min(MAX_OMITTED + 1, omitted + Math.max(1, count)); this.resource ??= resource;},
    result() {
      if (!omitted) {return entries;}
      const retained = entries.slice(0, Math.max(0, limit - 1));
      return [...retained, overflowIssue(issue, this.resource ?? "diagnostic", omitted + entries.length - retained.length)];
    },
  };
};

export const boundedIssueText = (issues, lineFor, limit = CHECKER_LIMITS.renderedBytes) => {
  const lines = [];
  let bytes = 0, omitted = 0;
  for (const entry of issues) {
    const line = lineFor(entry), extra = encodedLength(line) + (lines.length ? 1 : 0);
    if (bytes + extra <= limit) {lines.push(line); bytes += extra;}
    else {omitted += 1;}
  }
  if (!omitted) {return lines.join("\n");}
  const overflow = `<checker>:1 FM_CHECKER_OVERFLOW rendered output limit exceeded; omitted ${Math.min(MAX_OMITTED, omitted)}${omitted > MAX_OMITTED ? "+" : ""} item(s)`;
  while (lines.length && bytes + 1 + encodedLength(overflow) > limit) {
    const removed = lines.pop(); bytes -= encodedLength(removed) + (lines.length ? 1 : 0); omitted += 1;
  }
  return [...lines, overflow.replace(/omitted [0-9+]+/u, `omitted ${Math.min(MAX_OMITTED, omitted)}${omitted > MAX_OMITTED ? "+" : ""}`)].join("\n");
};
