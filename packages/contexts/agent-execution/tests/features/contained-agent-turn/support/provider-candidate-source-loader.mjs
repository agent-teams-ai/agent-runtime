import { registerHooks } from "node:module";

// Explicit source-only test invocation: redirect only Agent Execution's build
// imports to its actual sources. No module mocks, emitted files or provider run.
const packageRoot = new URL("../../../../", import.meta.url).href;
registerHooks({resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    const url = new URL(specifier, context.parentURL).href;
    if (url.startsWith(`${packageRoot}dist/`)) {
      return nextResolve(url.replace(`${packageRoot}dist/`, `${packageRoot}src/`).replace(/\.js$/u, ".ts"), context);
    }
    if (url.startsWith(`${packageRoot}src/`)) {
      return nextResolve(url.replace(/\.js$/u, ".ts"), context);
    }
  }
  return nextResolve(specifier, context);
}});
