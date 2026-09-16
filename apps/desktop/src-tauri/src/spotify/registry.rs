//! Resolving xpui's internal services from an injected script.
//!
//! xpui keeps its services in a registry that React exposes through a
//! context. The snippet below walks the fiber tree to that context and
//! resolves a service by its `Symbol.for(name)` key. See
//! docs/desktop/spotify-bridge/service-registry-keys.md.

use std::sync::LazyLock;

/// The prefix every failure of the walk itself carries.
///
/// The session demotes the bridge to `Lost` when a command's failure says the
/// page no longer holds what we resolved against. It can only read that off the
/// message text, and message text is not ours alone: a playlist the user named
/// after the error, or a paste echoed back by `normalise_playlist_uri`, puts
/// arbitrary words in front of the classifier. Matching bare English phrases
/// there hands any of them the power to drop the gate over a healthy bridge.
///
/// So the walk stamps its own failures. The prefix is ugly on purpose — it is
/// not a phrase a track title, a playlist name, or a pasted link can plausibly
/// contain, so a match on it means the walk failed and nothing else does.
pub const STALE_PREFIX: &str = "spotjam-walk-failed:";

/// JS source defining `resolveService(name)`. Splice it into an injected
/// script ahead of the first call.
pub static RESOLVE_SERVICE_JS: LazyLock<String> = LazyLock::new(|| {
    format!(
        r#"
  function resolveService(name) {{
    let fiberRoot = null;
    for (const el of document.querySelectorAll("*")) {{
      const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
      if (k) {{ fiberRoot = el[k]; break; }}
    }}
    if (!fiberRoot) throw new Error("{STALE_PREFIX} no React fiber found");

    let registry = null;
    const seen = new Set();
    const queue = [fiberRoot];
    let visited = 0;
    while (queue.length && visited < 20000) {{
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      visited++;
      let ctx = f.dependencies ? f.dependencies.firstContext : null;
      while (ctx) {{
        const val = ctx.memoizedValue;
        if (val && typeof val.resolve === "function") {{ registry = val; break; }}
        ctx = ctx.next;
      }}
      if (registry) break;
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }}
    if (!registry) throw new Error("{STALE_PREFIX} no RegistryContext found in fiber tree");

    const service = registry.resolve(Symbol.for(name));
    if (!service) throw new Error("registry.resolve(" + name + ") returned falsy");
    return service;
  }}
"#
    )
});

/// JS returning true once the page can actually serve a command.
///
/// The debug port opens well before xpui mounts, so a connection alone does
/// not mean anything is resolvable. Nor does a fiber: React commits its first
/// host element before the registry provider is anywhere in the tree, so
/// "some element carries a `__reactFiber` key" is true during a window where
/// `resolveService` still throws `no RegistryContext found in fiber tree`.
/// Ready would then be a lie and the first commands would fail.
///
/// So the probe asks the question readiness actually means: does
/// `resolveService("PlayerAPI")` — the exact walk every command performs —
/// succeed? It swallows its own failure so a not-yet-mounted page answers
/// `false` rather than throwing, and costs no more than the fiber scan it
/// replaces (measured on the live client: 0.3 ms against 0.4 ms).
pub static REACT_MOUNTED_JS: LazyLock<String> = LazyLock::new(|| {
    let resolve: &str = &RESOLVE_SERVICE_JS;
    format!(
        r#"(() => {{
  try {{
{resolve}
    return !!resolveService("PlayerAPI");
  }} catch (e) {{
    return false;
  }}
}})()"#
    )
});

/// Every `window` key an ensure script writes. One list, so dropping the
/// stashes cannot fall out of step with creating them.
pub const STASH_KEYS: [&str; 3] = ["__playerApi", "__playlistApi", "__metadataApi"];

/// JS that deletes every stash, so the next command re-resolves.
///
/// `ensure_script` returns early when its stash is truthy, which is what makes
/// repeated commands cheap. It also means a stash that survives its service is
/// never replaced. A cleared execution context usually takes `window` with it,
/// but not always: CDP clears contexts on a same-document navigation, where
/// `window` persists and the stash then points at a service instance the page
/// has abandoned. Commands would keep calling it and keep failing, with the
/// bridge reporting `ready`.
///
/// So the supervisor drops the stashes whenever it hears the context went
/// away. Deleting a key that was never set is a no-op, so this is safe to run
/// on a fresh `window` too.
pub static DROP_STASHES_JS: LazyLock<String> = LazyLock::new(|| {
    let deletes = STASH_KEYS
        .iter()
        .map(|key| format!("    delete window.{key};"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("(() => {{\n{deletes}\n    return true;\n}})()")
});

/// Builds an idempotent script that stashes a service on `window[stash]`.
/// `pick` is a JS expression over `resolveService` that yields the object
/// to stash.
pub fn ensure_script(stash: &str, pick: &str) -> String {
    let resolve: &str = &RESOLVE_SERVICE_JS;
    format!(
        "(() => {{\n  if (window.{stash}) return true;\n{resolve}\n  window.{stash} = {pick};\n  return true;\n}})()"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Readiness has to mean "a command would work", and a command works by
    /// resolving a service out of the registry context. A fiber key is not
    /// that: React commits host elements before the registry provider is in
    /// the tree, so a probe that stops at the first `__reactFiber` reports
    /// ready during a window where `resolveService` still throws. Verified
    /// against the live client — an element carrying a fiber key with no
    /// registry above it satisfies the fiber scan and fails the walk.
    #[test]
    fn the_ready_probe_resolves_a_service_rather_than_finding_a_fiber() {
        let probe: &str = &REACT_MOUNTED_JS;
        assert!(
            probe.contains(r#"resolveService("PlayerAPI")"#),
            "the ready probe must perform the resolve a command performs"
        );
        assert!(
            probe.contains("RegistryContext"),
            "the ready probe must include the registry walk, not just a fiber scan"
        );
    }

    /// A page that has not mounted must answer `false`, not throw: the poll
    /// reads a boolean and treats every other outcome as "keep waiting", so a
    /// throw would work by accident and an evaluation error would be
    /// indistinguishable from a dead socket.
    #[test]
    fn the_ready_probe_swallows_its_own_failure() {
        let probe: &str = &REACT_MOUNTED_JS;
        assert!(probe.contains("try {"), "the probe must catch its own throw");
        assert!(
            probe.contains("return false;"),
            "a page that cannot resolve must answer false"
        );
    }

    /// `ensure_script` refuses to re-resolve while its stash is truthy, so a
    /// stash that outlives its service is never replaced and every command
    /// fails against a bridge that still says `ready`. The drop script is what
    /// makes that impossible, and it has to name every key an ensure script
    /// writes — a key missed here is a service that stays stale.
    #[test]
    fn dropping_the_stashes_covers_every_key_an_ensure_script_writes() {
        let drop: &str = &DROP_STASHES_JS;
        for key in STASH_KEYS {
            assert!(
                drop.contains(&format!("delete window.{key};")),
                "the drop script must delete window.{key}"
            );
            // And the key must be one an ensure script actually creates.
            assert!(ensure_script(key, "x").contains(&format!("window.{key} = x")));
        }
    }

    /// Every stash the api modules create has to be in `STASH_KEYS`. This is
    /// the list the drop script is built from, so a stash missing from it is a
    /// stash that survives a cleared context.
    ///
    /// The scan reads the stash name as the first string literal after
    /// `ensure_script(`, not on the same line: two of the three call sites
    /// already wrap their arguments, and a line-anchored scan silently matched
    /// nothing in those files while still reporting success.
    #[test]
    fn the_stash_list_matches_the_stashes_the_bridge_creates() {
        let found = stashes_created_in_sources();
        for key in &found {
            assert!(
                STASH_KEYS.contains(&key.as_str()),
                "{key:?} is stashed but not in STASH_KEYS, so it survives a \
                 cleared context"
            );
        }
    }

    /// ADVERSARY. The scan above is only worth anything if it actually finds
    /// the call sites. It used to look for `ensure_script("` on one line —
    /// but `playlist_api.rs` and `track_api.rs` both wrap their arguments, so
    /// the scan matched zero times in each and the test passed by examining
    /// nothing. A stash added to either file would never have been caught.
    ///
    /// So assert the scan's own yield: it has to see every stash the bridge
    /// really creates, one per api module.
    #[test]
    fn the_stash_scan_actually_finds_every_call_site() {
        let found = stashes_created_in_sources();
        assert_eq!(
            found.len(),
            STASH_KEYS.len(),
            "the scan found {found:?}, but the bridge creates {STASH_KEYS:?} — \
             a scan that misses a call site proves nothing about it"
        );
        for key in STASH_KEYS {
            assert!(
                found.iter().any(|f| f == key),
                "the scan never saw {key:?} being stashed, so its presence in \
                 STASH_KEYS is unverified"
            );
        }
    }

    /// Reads the stash name out of every `ensure_script` call in the api
    /// modules. Argument lists wrap, so this scans the whole source rather
    /// than line by line.
    fn stashes_created_in_sources() -> Vec<String> {
        let sources = [
            include_str!("player_api.rs"),
            include_str!("playlist_api.rs"),
            include_str!("track_api.rs"),
        ];
        let mut found = Vec::new();
        for source in sources {
            // Skip this file's own test fixtures by scanning only calls that
            // are the real thing: `ensure_script(` followed, after any
            // whitespace, by a plain string literal.
            for (_, rest) in source.match_indices("ensure_script(").map(|(i, _)| {
                (i, &source[i + "ensure_script(".len()..])
            }) {
                let rest = rest.trim_start();
                let Some(after_quote) = rest.strip_prefix('"') else {
                    continue;
                };
                let Some(key) = after_quote.split('"').next() else {
                    continue;
                };
                found.push(key.to_string());
            }
        }
        found
    }

    /// ADVERSARY. `RESOLVE_SERVICE_JS` became a `format!` so the stamp could be
    /// interpolated, which means every brace in the walk now has to be doubled.
    /// Miss one and the script still *builds* and still contains every
    /// substring the other tests look for — it just no longer parses in the
    /// page, and every command fails at runtime with a syntax error.
    ///
    /// Braces cannot be counted naively (the source contains `"{"`-free string
    /// literals only, but a regex over JS is a trap), so this balances them and
    /// checks the shapes the doubling would have broken.
    #[test]
    fn the_walk_script_survived_being_made_a_format_string() {
        let resolve: &str = &RESOLVE_SERVICE_JS;

        let opens = resolve.matches('{').count();
        let closes = resolve.matches('}').count();
        assert_eq!(
            opens, closes,
            "unbalanced braces: the script will not parse in the page"
        );

        // A doubled brace that escaped its `format!` would show up literally.
        assert!(
            !resolve.contains("{{") && !resolve.contains("}}"),
            "a literal doubled brace survived into the emitted script"
        );

        // The block bodies most at risk from the rewrite.
        for shape in [
            "for (const el of document.querySelectorAll(\"*\")) {",
            "while (queue.length && visited < 20000) {",
            "while (ctx) {",
            "if (val && typeof val.resolve === \"function\") { registry = val; break; }",
            "if (k) { fiberRoot = el[k]; break; }",
        ] {
            assert!(
                resolve.contains(shape),
                "the walk lost its shape at {shape:?}"
            );
        }

        // And the function must still open and close.
        assert!(resolve.contains("function resolveService(name) {"));
        assert!(resolve.trim_end().ends_with('}'));
    }

    /// Dumps the generated scripts so they can be evaluated against a real
    /// Spotify page. Not part of the suite — it writes files and needs a
    /// running client. Run with:
    /// `cargo test dump_generated_scripts -- --ignored --nocapture`
    #[test]
    #[ignore = "writes files; for checking the emitted JS against a live client"]
    fn dump_generated_scripts() {
        let dir = std::env::var("SPOTJAM_JS_DUMP").expect("set SPOTJAM_JS_DUMP to a directory");
        let write = |name: &str, body: &str| {
            std::fs::write(format!("{dir}/{name}"), body).expect("dump must be writable");
        };
        write("ready.js", &REACT_MOUNTED_JS);
        write("drop.js", &DROP_STASHES_JS);
        write(
            "ensure_player.js",
            &ensure_script("__probePlayerApi", r#"resolveService("PlayerAPI")"#),
        );
        println!("wrote the emitted scripts to {dir}");
    }

    /// The stash guard and the resolve walk both have to be in an ensure
    /// script, or a reload leaves a service that never gets re-resolved.
    #[test]
    fn an_ensure_script_guards_the_stash_and_carries_the_walk() {
        let script = ensure_script("__thing", r#"resolveService("Thing")"#);
        assert!(script.contains("if (window.__thing) return true;"));
        assert!(script.contains("function resolveService(name)"));
        assert!(script.contains("window.__thing = resolveService(\"Thing\")"));
    }
}
