// Entrypoint — read the environment, build the real dependencies, listen.

import { SqliteManifestStore } from "./manifest-store.ts";
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from "./server.ts";
import { resolveDbPath, SqliteIdentityStore } from "./sqlite-identity-store.ts";

function envPort(): number {
  const parsed = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

const dbPath = resolveDbPath();
const identities = new SqliteIdentityStore(dbPath);
// The updater manifest shares the identity database: one file, one volume.
const manifests = new SqliteManifestStore(dbPath);
const host = process.env.HOST ?? DEFAULT_HOST;

const server = await startServer({
  host,
  port: envPort(),
  identities,
  manifests,
  releaseToken: process.env.SPOTJAM_RELEASE_TOKEN,
});
console.log(`spotjam server listening on ${host}:${server.port} (db: ${dbPath})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => {
      identities.close();
      manifests.close();
      process.exit(0);
    });
  });
}
