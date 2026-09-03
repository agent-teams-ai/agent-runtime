import { createHash } from "node:crypto";

const bytewise = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

const encode = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {return JSON.stringify(value);}
  if (typeof value === "number" && Number.isFinite(value)) {return JSON.stringify(value);}
  if (Array.isArray(value)) {return `[${value.map(encode).join(",")}]`;}
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).toSorted(bytewise).map(key => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Docker create specification is not canonically serializable");
};

export const canonicalJsonSha256 = (value: unknown): string =>
  createHash("sha256").update(encode(value)).digest("hex");

export const bytewiseStringOrder = (left: string, right: string): number => bytewise(left, right);
