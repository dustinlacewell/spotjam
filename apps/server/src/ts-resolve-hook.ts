// Module resolution hook — lets bare Node load the workspace's TypeScript.
//
// @spotjam/protocol is published as source and its internal imports spell the
// compiled extension (`./canonical.js`), which is correct TypeScript and what
// a bundler expects. Node's type-stripping does not perform that remap: it
// resolves the literal specifier, finds no .js on disk, and the process dies
// before it listens.
//
// The protocol package is the frozen contract, so the fix lives here: when a
// relative .js specifier has no file behind it but a sibling .ts does, resolve
// the .ts instead. Nothing else is redirected.
//
// Do not "simplify" this by stripping the .js extensions in the protocol
// package: Node's ESM resolver performs no extension search, so extensionless
// relative imports fail there too. Vite and vitest tolerate both spellings,
// which is exactly why that breakage does not show up in any test suite --
// only in a real `node src/main.ts`.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface ResolveContext {
  parentURL?: string | undefined;
}

interface Resolved {
  url: string;
  format?: string | null | undefined;
  shortCircuit?: boolean | undefined;
}

type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => Resolved | Promise<Resolved>;

const RELATIVE = /^\.{1,2}\//;

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<Resolved> {
  if (RELATIVE.test(specifier) && specifier.endsWith(".js")) {
    const candidate = await tryTypeScriptSibling(specifier, context, nextResolve);
    if (candidate !== null) return candidate;
  }
  return nextResolve(specifier, context);
}

/** Resolve the .ts sibling, but only when the .js genuinely is not there. */
async function tryTypeScriptSibling(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<Resolved | null> {
  let jsUrl: string;
  try {
    jsUrl = (await nextResolve(specifier, context)).url;
  } catch {
    // Unresolvable as .js; fall through to the .ts candidate below.
    jsUrl = new URL(specifier, context.parentURL ?? import.meta.url).href;
  }

  if (!jsUrl.startsWith("file:") || existsSync(fileURLToPath(jsUrl))) return null;

  const tsUrl = `${jsUrl.slice(0, -".js".length)}.ts`;
  if (!existsSync(fileURLToPath(tsUrl))) return null;

  // No explicit format: naming "module" would hand Node the .ts source as
  // finished JavaScript and it would choke on the first type annotation.
  // Left unset, Node classifies the .ts itself and strips the types.
  return { url: tsUrl, shortCircuit: true };
}
