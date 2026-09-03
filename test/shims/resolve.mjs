/**
 * Module-customization resolve hook: map the bare `cloudflare:workers` specifier
 * to the local test shim so `src/worker/*` can be imported under `node:test`.
 * Everything else passes straight through.
 */
const SHIM = new URL("./cloudflare-workers.mjs", import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: SHIM, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
