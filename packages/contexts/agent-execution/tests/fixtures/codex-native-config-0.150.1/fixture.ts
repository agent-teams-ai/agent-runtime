import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type NativeRecord = Record<string, unknown>;
export interface NativeLayer {
  config: NativeRecord;
  disabledReason?: unknown;
  name: NativeRecord;
  version: string;
}
export interface NativeConfigResult {
  config: NativeRecord;
  layers: NativeLayer[];
  origins: Record<string, { name: NativeRecord; version: string }>;
}

export const nativeFixtureUrl = new URL("./config-read.linux-analysis.json", import.meta.url);
export const nativeFixtureHome = "/synthetic/agent-runtime-native-config/private-home";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).toSorted(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Synthetic mutations of layer content must update both version and leaf metadata. */
export const rehashNativeLayers = (result: NativeConfigResult): void => {
  for (const layer of result.layers) {
    const old = layer.version;
    layer.version = `sha256:${createHash("sha256").update(canonical(layer.config)).digest("hex")}`;
    for (const origin of Object.values(result.origins)) {
      if (origin.version === old && canonical(origin.name) === canonical(layer.name)) {
        origin.version = layer.version;
      }
    }
  }
};

/** Rebase only synthetic paths and permission inheritance. All native defaults,
 * feature values, leaf names, optional-field omission and ordering are retained.
 * workspace-write is derived contract coverage, not an additional native capture.
 */
export const nativeConfigResult = (
  codexHome = nativeFixtureHome,
  mode: "analysis" | "workspace-write" = "analysis",
): NativeConfigResult => {
  const transform = (value: unknown): unknown => {
    if (typeof value === "string") {return value.replaceAll(nativeFixtureHome, codexHome);}
    if (Array.isArray(value)) {return value.map(transform);}
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
        key.replaceAll(nativeFixtureHome, codexHome), transform(nested),
      ]));
    }
    return value;
  };
  const result = transform(JSON.parse(readFileSync(nativeFixtureUrl, "utf8"))) as NativeConfigResult;
  if (mode === "workspace-write") {
    const effective = result.config.permissions as Record<string, NativeRecord>;
    const user = result.layers.find(layer => layer.name.type === "user")!.config.permissions as Record<string, NativeRecord>;
    effective["agent-runtime-contained-v1"]!.extends = ":workspace";
    user["agent-runtime-contained-v1"]!.extends = ":workspace";
  }
  rehashNativeLayers(result);
  return result;
};
