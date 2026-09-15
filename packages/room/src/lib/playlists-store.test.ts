import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlaylists, savePlaylists } from "./playlists-store";

const KEY = "spotjam.playlists";
const TRACK = { uri: "spotify:track:aaaa1111", trackId: "aaaa1111" };

/** The store reads a global `localStorage`; node has none, so stand one up. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

const LOCAL = { kind: "local" } as const;
const LINK = { kind: "spotify", playlistId: "pppp1111", syncedAt: 1000 } as const;

describe("loadPlaylists", () => {
  it("loads a playlist stored before sharing existed as private", () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: "one", name: "Morning", tracks: [TRACK] }]));
    expect(loadPlaylists()).toEqual([
      { id: "one", name: "Morning", tracks: [TRACK], isPublic: false, source: LOCAL },
    ]);
  });

  it("keeps a stored public flag", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "one", name: "Morning", tracks: [], isPublic: true }]),
    );
    expect(loadPlaylists()[0].isPublic).toBe(true);
  });

  it("treats a non-boolean flag as private", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "one", name: "Morning", tracks: [], isPublic: "yes" }]),
    );
    expect(loadPlaylists()[0].isPublic).toBe(false);
  });

  it("round-trips through savePlaylists", () => {
    const lists = [
      { id: "one", name: "Morning", tracks: [TRACK], isPublic: true, source: LOCAL },
    ];
    savePlaylists(lists);
    expect(loadPlaylists()).toEqual(lists);
  });

  it("is empty when nothing is stored", () => {
    expect(loadPlaylists()).toEqual([]);
  });
});

describe("loadPlaylists and the playlist source", () => {
  it("loads a playlist stored before linking existed as local", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "one", name: "Morning", tracks: [], isPublic: false }]),
    );
    expect(loadPlaylists()[0].source).toEqual(LOCAL);
  });

  it("keeps a stored link", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "one", name: "Morning", tracks: [], isPublic: false, source: LINK }]),
    );
    expect(loadPlaylists()[0].source).toEqual(LINK);
  });

  it("round-trips a linked playlist", () => {
    const lists = [
      { id: "one", name: "From Spotify", tracks: [TRACK], isPublic: false, source: LINK },
    ];
    savePlaylists(lists);
    expect(loadPlaylists()).toEqual(lists);
  });

  /**
   * A half-written source must not produce a playlist that claims to mirror a
   * playlist id it does not have — that playlist would be syncable, and a sync
   * can drop it.
   */
  it("degrades a malformed source to local", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "a", name: "No id", tracks: [], isPublic: false, source: { kind: "spotify" } },
        {
          id: "b",
          name: "Empty id",
          tracks: [],
          isPublic: false,
          source: { kind: "spotify", playlistId: "" },
        },
        { id: "c", name: "Nonsense", tracks: [], isPublic: false, source: "spotify" },
        { id: "d", name: "Null", tracks: [], isPublic: false, source: null },
      ]),
    );
    for (const list of loadPlaylists()) {
      expect(list.source).toEqual(LOCAL);
    }
  });
});
