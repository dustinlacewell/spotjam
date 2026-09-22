# Scoped testing

Run everything that could have changed, nothing more. The full suite
(`pnpm run test` = `pnpm -r test`) protects review and CI — it is not the
default for a single edit. CLAUDE.md's "Tests" section holds the decision
rule (which tier to run when); this file holds the commands.

## Suite map

The suite boundary is the package boundary. One vitest project per workspace
package: each package's `test` script runs its own vitest project over its
own colocated tests, in its own config, sharing nothing at runtime. Within a
package, a sub-suite follows the directory structure — a test belongs to the
sub-suite of the module it tests, which is the directory it already lives in.

| Package | Full suite | Sub-suites |
|---|---|---|
| `@spotjam/desktop` | `pnpm --filter @spotjam/desktop test` | `test:lib` (`src/lib`), `test:playback` (`src/lib/playback`) |
| `@spotjam/server` | `pnpm --filter @spotjam/server test` | `test:wire` (`interop`/`session`/`server` — the wire contract) |
| `@spotjam/protocol` | `pnpm --filter @spotjam/protocol test` | — (flat) |
| `@spotjam/room` | `pnpm --filter @spotjam/room test` | `test:lib` (`src/lib`), `test:mock` (`src/mock`) |
| `@spotjam/ui` | `pnpm --filter @spotjam/ui test` | — (one file) |
| `@spotjam/site` | `pnpm --filter @spotjam/site test` | — (one file) |

Sub-suite scripts are only defined where a sub-suite exists; packages with a
flat test layout are already one command. When nothing smaller fits, running
a single file is always available and cheapest of all:

    pnpm --filter @spotjam/desktop exec vitest run src/lib/playback/reconcile.test.ts

Every package config sets `fsModuleCache: true`, so transformed modules
persist between runs and scoped runs start fast. `vitest run --clearCache`
wipes it.

## Shared test helpers

Test support lives next to the code it serves, in a `testing.ts` the package
owns — not duplicated per test file:

- `apps/server/src/testing.ts` — `FakeClock`, `FakeTimers`,
  `RecordingSocket`, `seededRng`, `frame`, `repeat`, plus the shared
  `track` / `trackIds` / `waitFor` helpers.
- `packages/room/src/testing.ts` — `describeRoomContract`, exported from the
  package's `./testing` subpath export.
- `apps/desktop/src/lib/testing.ts` — `fromHex`.

Put a new helper in the owning package's `testing.ts` and import it; do not
copy it into a second test file.

## Rust

The desktop's Rust tests are inline `#[cfg(test)]` modules under
`apps/desktop/src-tauri/src/spotify/`. Run the module that matches the file
you touched:

    cd apps/desktop/src-tauri
    cargo test spotify::player_api         # one module
    cargo test spotify::                    # the whole bridge