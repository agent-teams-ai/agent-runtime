// Load after the supplied source hook and before any test/product imports.
// The source hook retains its own source reader; product effects are replaced.
import { registerHooks } from "node:module";

const blocked = new Map([
  ["node:fs", ["readFileSync", "statSync", "lstatSync", "realpathSync", "readdirSync"]],
  ["node:fs/promises", ["lstat", "realpath", "open", "readFile", "writeFile", "mkdir"]],
  ["node:child_process", ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
  ["node:net", ["createServer", "createConnection", "connect", "Socket", "Server"]],
  ["node:tls", ["connect", "createServer", "TLSSocket"]],
  ["node:http", ["request", "get", "createServer", "Agent"]],
  ["node:https", ["request", "get", "createServer", "Agent"]],
  ["node:dns", ["lookup", "resolve", "Resolver"]],
  ["node:dns/promises", ["lookup", "resolve", "Resolver"]],
  ["node:dgram", ["createSocket"]],
  ["node:worker_threads", ["Worker"]],
  ["@agent-teams/filesystem-custody/composition", ["openStablePath", "capturePathLineage", "pathLineagesEqual"]],
]);

registerHooks({
  resolve(specifier, context, next) {
    const names = blocked.get(specifier.startsWith("node:") || specifier.startsWith("@")
      ? specifier : `node:${specifier}`);
    if (names !== undefined) {
      const source = 'const denied = () => { throw new Error("staged-ingress fixture forbids effects"); };\n'
        + names.map(name => `export const ${name} = denied;`).join("\n")
        + `\nexport default Object.freeze({${names.join(",")}});`;
      return {url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true};
    }
    return next(specifier, context);
  },
});
