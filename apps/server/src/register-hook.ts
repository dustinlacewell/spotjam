// Registers the resolution hook. Loaded via `node --import` before main.ts,
// because a hook cannot install itself from inside the graph it fixes.

import { register } from "node:module";

register("./ts-resolve-hook.ts", import.meta.url);
