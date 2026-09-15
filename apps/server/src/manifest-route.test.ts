// Integration — the updater manifest over real HTTP against a listening server.

import { afterEach, describe, expect, it } from "vitest";

import { MemoryIdentityStore } from "./identity-store.ts";
import { MemoryManifestStore } from "./manifest-store.ts";
import { startServer, type RunningServer } from "./server.ts";
import type { ManifestStore } from "./manifest-store.ts";

const TOKEN = "test-release-token";

const WINDOWS = { url: "https://example.test/spotjam.msi.zip", signature: "sig-win" };
const MAC = { url: "https://example.test/spotjam.app.tar.gz", signature: "sig-mac" };

let running: RunningServer | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function start(
  options: { manifests?: ManifestStore; releaseToken?: string | undefined } = {},
): Promise<RunningServer> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    identities: new MemoryIdentityStore(),
    manifests: options.manifests ?? new MemoryManifestStore(),
    releaseToken: "releaseToken" in options ? options.releaseToken : TOKEN,
  });
  return running;
}

function post(port: number, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/latest.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/latest.json`);
}

describe("GET /latest.json", () => {
  // Tauri reads 204 as "no update available", which is the truth pre-release.
  it("answers 204 before anything is posted", async () => {
    const server = await start();
    expect((await get(server.port)).status).toBe(204);
  });

  it("serves what was posted", async () => {
    const server = await start();
    await post(server.port, { version: "0.2.0", platforms: { "windows-x86_64": WINDOWS } });

    const response = await get(server.port);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: "0.2.0",
      platforms: { "windows-x86_64": WINDOWS },
    });
  });

  it("survives a restart when the store is durable", async () => {
    const store = new MemoryManifestStore();
    const first = await start({ manifests: store });
    await post(first.port, { version: "0.2.0", platforms: { "darwin-aarch64": MAC } });
    await first.close();

    const second = await start({ manifests: store });
    expect(await (await get(second.port)).json()).toMatchObject({ version: "0.2.0" });
  });
});

describe("POST /latest.json", () => {
  it("refuses a missing token", async () => {
    const server = await start();
    const response = await post(server.port, { version: "0.2.0", platforms: {} }, null);
    expect(response.status).toBe(401);
  });

  it("refuses a wrong token", async () => {
    const server = await start();
    const response = await post(
      server.port,
      { version: "0.2.0", platforms: { "windows-x86_64": WINDOWS } },
      "wrong-token-of-same-length!!",
    );
    expect(response.status).toBe(401);
    expect((await get(server.port)).status).toBe(204);
  });

  // An unconfigured server must not accept anonymous writes.
  it("closes the route when no token is configured", async () => {
    const server = await start({ releaseToken: undefined });
    const response = await post(
      server.port,
      { version: "0.2.0", platforms: { "windows-x86_64": WINDOWS } },
      null,
    );
    expect(response.status).toBe(503);
  });

  it("refuses malformed json", async () => {
    const server = await start();
    expect((await post(server.port, "{not json")).status).toBe(400);
  });

  it("refuses a manifest of the wrong shape", async () => {
    const server = await start();
    expect((await post(server.port, { version: "0.2.0" })).status).toBe(400);
    expect((await post(server.port, { platforms: { "linux-x86_64": MAC } })).status).toBe(400);
  });

  // The whole reason the workflows can run independently.
  it("merges platforms posted by separate workflows", async () => {
    const server = await start();

    await post(server.port, { version: "0.2.0", platforms: { "windows-x86_64": WINDOWS } });
    await post(server.port, { version: "0.2.0", platforms: { "darwin-aarch64": MAC } });

    const manifest = (await (await get(server.port)).json()) as {
      platforms: Record<string, unknown>;
    };
    expect(Object.keys(manifest.platforms).sort()).toEqual(["darwin-aarch64", "windows-x86_64"]);
  });

  it("lets one platform be rebuilt without disturbing the others", async () => {
    const server = await start();
    await post(server.port, {
      version: "0.2.0",
      platforms: { "windows-x86_64": WINDOWS, "darwin-aarch64": MAC },
    });

    const rebuilt = { url: "https://example.test/rebuilt.msi.zip", signature: "sig-win-2" };
    await post(server.port, { version: "0.2.0", platforms: { "windows-x86_64": rebuilt } });

    const manifest = (await (await get(server.port)).json()) as {
      platforms: Record<string, unknown>;
    };
    expect(manifest.platforms["windows-x86_64"]).toEqual(rebuilt);
    expect(manifest.platforms["darwin-aarch64"]).toEqual(MAC);
  });

  it("clears stale platforms when the version moves", async () => {
    const server = await start();
    await post(server.port, { version: "0.1.0", platforms: { "darwin-aarch64": MAC } });
    await post(server.port, { version: "0.2.0", platforms: { "windows-x86_64": WINDOWS } });

    const manifest = (await (await get(server.port)).json()) as {
      version: string;
      platforms: Record<string, unknown>;
    };
    expect(manifest.version).toBe("0.2.0");
    expect(manifest.platforms).toEqual({ "windows-x86_64": WINDOWS });
  });

  it("rejects anything but GET and POST", async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/latest.json`, {
      method: "DELETE",
    });
    expect(response.status).toBe(405);
  });
});
