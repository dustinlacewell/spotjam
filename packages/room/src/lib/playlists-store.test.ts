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

describe("loadPlaylists", () => {
  it("loads a playlist stored before sharing existed as private", () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: "one", name: "Morning", tracks: [TRACK] }]));
    expect(loadPlaylists()).toEqual([
      { id: "one", name: "Morning", tracks: [TRACK], isPublic: false },
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
    const lists = [{ id: "one", name: "Morning", tracks: [TRACK], isPublic: true }];
    savePlaylists(lists);
    expect(loadPlaylists()).toEqual(lists);
  });

  it("is empty when nothing is stored", () => {
    expect(loadPlaylists()).toEqual([]);
  });
});
