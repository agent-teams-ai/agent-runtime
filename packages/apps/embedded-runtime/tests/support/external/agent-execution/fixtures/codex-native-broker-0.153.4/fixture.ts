import { readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { rehashNativeLayers, type NativeConfigResult } from "../codex-native-config-0.153.4/fixture.ts";
import { createCodexAppServerPermissionBoundary,createCodexNativeBrokerRecipe,renderCodexNativeBrokerConfig,prepareCodexNativeBrokerFiles } from "@agent-teams/agent-execution/composition";

export type Mode = "analysis" | "workspace-write";
export const captureUrl = (mode: Mode) => new URL(`./capture.darwin-${mode}.json`, import.meta.url);
export const capture = (mode: Mode) => JSON.parse(readFileSync(captureUrl(mode), "utf8"));
export const catalogUrl = new URL("./models.json", import.meta.url);
export const fixtureEndpoint = "http://10.203.0.1:43129/backend-api/codex";
export const fixtureCapability = "synthetic_private_broker_capability_0123456789";

/** The raw captures remain byte-exact. Only the disposable root and layer/origin
 * digests are transformed; neither intent is synthesized from the other.
 */
export const nativeBrokerConfig = (home: string, mode: Mode = "analysis"): NativeConfigResult => {
  const raw = capture(mode);
  const originalHome = `${raw.project}/private-home`;
  const transform = (value: unknown): unknown => {
    if (typeof value === "string") {return value.replaceAll(originalHome, home);}
    if (Array.isArray(value)) {return value.map(transform);}
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
        key.replaceAll(originalHome, home), transform(nested),
      ]));
    }
    return value;
  };
  const result = transform(raw.messages.find((message: { id?: string }) => message.id === "config").result) as NativeConfigResult;
  rehashNativeLayers(result);
  return result;
};

export const brokerFixture = (t: TestContext, mode: Mode = "analysis") => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ar69-native-broker-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const privateRootPath = join(root, "private"); const home = join(privateRootPath, "home.é-😀");
  const workspace = join(root, "workspace"); const tmpDir = join(privateRootPath, "tmp");
  for (const path of [privateRootPath, home, workspace, tmpDir]) {mkdirSync(path, { mode: 0o700 });}
  const boundary = createCodexAppServerPermissionBoundary({ codexHome: home, workspaceRef: workspace, intentMode: mode });
  const recipe = createCodexNativeBrokerRecipe({ boundary, endpoint: fixtureEndpoint, profile: "codex-chatgpt" });
  const launchOptions = {
    boundary, executablePath: "/synthetic/not-executed/codex", intentMode: mode,
    platformTarget: { architecture: "x64", platform: "linux" } as const, privateRootPath, tmpDir,
  };
  return { boundary, recipe, root, home, workspace, launchOptions,
    async prepare() {
      writeFileSync(join(home, "config.toml"), renderCodexNativeBrokerConfig(recipe), { mode: 0o600 });
      writeFileSync(join(home, "models.json"), readFileSync(catalogUrl), { mode: 0o600 });
      return prepareCodexNativeBrokerFiles(recipe);
    },
  };
};
