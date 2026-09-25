// Package observation policy. No filesystem, process, or EF transport dependency.
export function inspectSurface(sourceManifest, packedManifest, files) {
  if (JSON.stringify(Object.keys(sourceManifest.exports ?? {})) !== JSON.stringify([".", "./composition"])) {
    throw new Error("surface: unsupported export paths or order");
  }
  const exports = Object.entries(sourceManifest.exports).map(([path, branches]) => {
    if (JSON.stringify(Object.keys(branches ?? {})) !== JSON.stringify(["types", "import"])) {
      throw new Error("surface: unsupported branch conditions or order");
    }
    return { path, branches: Object.entries(branches).map(([condition, target]) => {
      if (typeof target !== "string" || !/^\.\/dist\/[a-z0-9/-]+\.(?:d\.ts|js)$/u.test(target) ||
          !files.has(target.slice(2)) || (condition === "types") !== target.endsWith(".d.ts")) {
        throw new Error(`surface: missing or unsupported ${path}/${condition} target`);
      }
      return { condition, target };
    }) };
  });
  if (JSON.stringify(packedManifest.exports) !== JSON.stringify(sourceManifest.exports)) {
    throw new Error("surface: packed export conditions changed");
  }
  const census = { declarations: [], javascript: [], native: [], other: [] };
  for (const path of files.keys()) {
    if (path.endsWith(".d.ts")) { census.declarations.push(path); }
    else if (path.endsWith(".js")) { census.javascript.push(path); }
    else if (path.endsWith(".node")) { census.native.push(path); }
    else { census.other.push(path); }
  }
  for (const [kind, members] of Object.entries(census)) { census[kind] = members.toSorted(); }
  if (!census.native.includes("dist/rename-no-replace.node")) { throw new Error("surface: expected native member missing"); }
  return { exports, census, typedClosure: "incomplete", runtimeReachability: "incomplete", nativeClosure: "incomplete" };
}
