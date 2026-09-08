// Shared before fixture evaluation so native bindings can be installed before
// the base fixture imports (and caches) the concrete adapters.
export const modules = new Map<string, Record<string, unknown>>();
