/**
 * Registers the `cloudflare:workers` resolve shim before any test module loads.
 * Referenced from `package.json`'s `test` script as `--import`.
 */
import { register } from "node:module";

register("./resolve.mjs", import.meta.url);
