import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// The isolated copy has no adjacent native binding, so this must run outside the
// suite process: a literal specifier cannot name a disposable temporary path,
// and the checker rejects nonliteral loading in owned test sources.
const [, , modulePath] = process.argv;
const isolated = await import(pathToFileURL(modulePath).href);
assert.equal(isolated.hasDarwinHostDescriptors(), false);
assert.throws(() => isolated.openNativeHostRoot(), /unavailable/);
