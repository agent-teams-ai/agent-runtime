const PRODUCTION_LINE_LIMITS = Object.freeze({ adapters: 600, application: 500, domain: 500 });
const EXCLUDED = /(?:^|\/)(?:fixtures|generated|vendor)(?:\/|$)|\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u;

const countedProductionLines = (source, comments) => {
  const masked = source.split("");
  for (const comment of comments ?? []) {
    const start = comment?.start ?? comment?.span?.start, end = comment?.end ?? comment?.span?.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {continue;}
    for (let index = start; index < Math.min(end, masked.length); index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") {masked[index] = " ";}
    }
  }
  return masked.join("").split(/\r?\n/u).filter((line) => line.trim()).length;
};

export const maintainabilityIssues = ({ comments, issue, path, role, source }) => {
  if (!source || EXCLUDED.test(path)) {return [];}
  const limit = PRODUCTION_LINE_LIMITS[role];
  if (!limit) {return [];}
  const actual = countedProductionLines(source, comments);
  return actual > limit
    ? [issue("FM_MAX_LINES", path, 1, `${path} has ${actual} counted production lines; limit ${limit}`)]
    : [];
};
