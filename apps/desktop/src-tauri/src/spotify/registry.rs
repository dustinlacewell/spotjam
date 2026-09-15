//! Resolving xpui's internal services from an injected script.
//!
//! xpui keeps its services in a registry that React exposes through a
//! context. The snippet below walks the fiber tree to that context and
//! resolves a service by its `Symbol.for(name)` key. See
//! docs/desktop/spotify-bridge/service-registry-keys.md.

/// JS source defining `resolveService(name)`. Splice it into an injected
/// script ahead of the first call.
pub const RESOLVE_SERVICE_JS: &str = r#"
  function resolveService(name) {
    let fiberRoot = null;
    for (const el of document.querySelectorAll("*")) {
      const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
      if (k) { fiberRoot = el[k]; break; }
    }
    if (!fiberRoot) throw new Error("no React fiber found");

    let registry = null;
    const seen = new Set();
    const queue = [fiberRoot];
    let visited = 0;
    while (queue.length && visited < 20000) {
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      visited++;
      let ctx = f.dependencies ? f.dependencies.firstContext : null;
      while (ctx) {
        const val = ctx.memoizedValue;
        if (val && typeof val.resolve === "function") { registry = val; break; }
        ctx = ctx.next;
      }
      if (registry) break;
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    if (!registry) throw new Error("no RegistryContext found in fiber tree");

    const service = registry.resolve(Symbol.for(name));
    if (!service) throw new Error("registry.resolve(" + name + ") returned falsy");
    return service;
  }
"#;

/// Builds an idempotent script that stashes a service on `window[stash]`.
/// `pick` is a JS expression over `resolveService` that yields the object
/// to stash.
pub fn ensure_script(stash: &str, pick: &str) -> String {
    format!(
        "(() => {{\n  if (window.{stash}) return true;\n{RESOLVE_SERVICE_JS}\n  window.{stash} = {pick};\n  return true;\n}})()"
    )
}
