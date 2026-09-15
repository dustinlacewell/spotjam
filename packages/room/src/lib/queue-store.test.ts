import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadQueue, saveQueue } from "./queue-store";

const ROOM = "jam";
const KEY = `spotjam.queue.${ROOM}`;
const ITEM = { id: "i1", uri: "spotify:track:aaaa1111", trackId: "aaaa1111" };

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

describe("queue store", () => {
  it("round-trips a queue", () => {
    saveQueue(ROOM, [ITEM]);
    expect(loadQueue(ROOM)).toEqual([ITEM]);
  });

  it("is empty when nothing is stored", () => {
    expect(loadQueue(ROOM)).toEqual([]);
  });

  it("keeps each room's queue apart", () => {
    saveQueue(ROOM, [ITEM]);
    expect(loadQueue("other")).toEqual([]);
  });

  it("is empty when the stored value is not JSON", () => {
    localStorage.setItem(KEY, "not json");
    expect(loadQueue(ROOM)).toEqual([]);
  });

  it("is empty when the stored value is not an array", () => {
    localStorage.setItem(KEY, JSON.stringify({ id: "i1" }));
    expect(loadQueue(ROOM)).toEqual([]);
  });

  it("is empty when any entry is malformed", () => {
    localStorage.setItem(KEY, JSON.stringify([ITEM, { id: "i2", uri: "u2" }]));
    expect(loadQueue(ROOM)).toEqual([]);
  });

  it("swallows a storage that refuses to write", () => {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    expect(() => saveQueue(ROOM, [ITEM])).not.toThrow();
  });

  it("returns an empty queue when reading throws", () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(loadQueue(ROOM)).toEqual([]);
  });
});
