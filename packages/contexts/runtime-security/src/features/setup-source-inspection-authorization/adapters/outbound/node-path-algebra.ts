import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PathAlgebra } from "../../application/ports/outbound/path-algebra.js";

export const createNodePathAlgebra = (): PathAlgebra =>
  Object.freeze({ isAbsolute, join, relative, resolve, sep });
