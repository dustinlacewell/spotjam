import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { cmd } from "@ldlework/workmark/define";

/**
 * Cut a release: stamp the version into every manifest, refresh Cargo.lock,
 * commit `spotjam <version>`, tag `v<version>`, and push. The tag push starts
 * the desktop release workflows.
 *
 * The tree must be clean, so the release commit holds the bump alone.
 */
export default cmd({
  args: { version: z.string().regex(/^\d+\.\d+\.\d+$/, "expected x.y.z") },
  flags: { push: z.boolean().default(true) },
  handler: async ({ version, push }, ctx) => {
    const root = ctx.workspace.root;
    const dirty = await ctx.sh("git status --porcelain");
    if (text(dirty).trim() !== "") return ctx.fail("working tree is not clean");

    for (const file of MANIFESTS) stamp(join(root, file), version);

    const lock = await ctx.exec("cargo check -q", { cwd: join(root, TAURI_DIR) });
    if (lock.isError) return lock;

    const changed = text(await ctx.sh("git diff --name-only")).trim().split(/\r?\n/).sort();
    const expected = [...MANIFESTS, LOCKFILE].sort();
    if (changed.join() !== expected.join()) {
      return ctx.fail(`bump touched unexpected files: ${changed.join(", ")}`);
    }

    const steps = [
      `git add ${expected.join(" ")}`,
      `git commit -q -m "spotjam ${version}"`,
      `git tag v${version}`,
    ];
    if (push) steps.push(`git push -q origin HEAD v${version}`);
    return ctx.sh(steps);
  },
});

const TAURI_DIR = "apps/desktop/src-tauri";
const LOCKFILE = `${TAURI_DIR}/Cargo.lock`;
const MANIFESTS = [
  "package.json",
  "apps/desktop/package.json",
  `${TAURI_DIR}/tauri.conf.json`,
  `${TAURI_DIR}/Cargo.toml`,
];

/** Rewrite the file's version line in place. Line endings and layout survive. */
function stamp(path: string, version: string): void {
  const before = readFileSync(path, "utf8");
  const after = bumpVersion(before, version);
  if (after === before) throw new Error(`no version line found in ${path}`);
  writeFileSync(path, after);
}

/** The first `"version": "x.y.z"` (JSON) or `version = "x.y.z"` (TOML) line. */
export function bumpVersion(text: string, version: string): string {
  return text.replace(
    /^(\s*"version":\s*"|version\s*=\s*")\d+\.\d+\.\d+(")/m,
    `$1${version}$2`,
  );
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}
