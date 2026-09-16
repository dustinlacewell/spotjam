import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlaylists, savePlaylists } from "./playlists-store";

const KEY = "spotjam.playlists";
const TRACK = { uri: "spotify:track:aaaa1111", trackId: "aaaa1111", durationMs: 180_000 };
const ROW = { track: TRACK };

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
const LINK = {
  kind: "spotify",
  playlistId: "pppp1111",
  syncedAt: 1000,
  canAdd: true,
  canEditItems: true,
} as const;

describe("loadPlaylists", () => {
  it("loads a playlist stored before sharing existed as private", () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: "one", name: "Morning", rows: [ROW] }]));
    expect(loadPlaylists()).toEqual([
      { id: "one", name: "Morning", rows: [ROW], isPublic: false, source: LOCAL },
    ]);
  });

  it("keeps a stored public flag", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "one", name: "Morning", rows: [], isPublic: true }]),
    );
    expect(loadPlaylists()[0].isPublic).toBe(true);
  });

  it("treats a non-boolean flag as private", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "one", name: "Morning", rows: [], isPublic: "yes" }]),
    );
    expect(loadPlaylists()[0].isPublic).toBe(false);
  });

  it("round-trips through savePlaylists", () => {
    const lists = [{ id: "one", name: "Morning", rows: [ROW], isPublic: true, source: LOCAL }];
    savePlaylists(lists);
    expect(loadPlaylists()).toEqual(lists);
  });

  it("is empty when nothing is stored", () => {
    expect(loadPlaylists()).toEqual([]);
  });
});

describe("loadPlaylists and rows", () => {
  /**
   * Stored before rows existed: bare tracks become rows with no Spotify
   * identity, which is correct — a uid only ever came from a sync.
   */
  it("migrates a stored track list to rows", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "one", name: "Morning", tracks: [TRACK], isPublic: true }]),
    );
    expect(loadPlaylists()[0].rows).toEqual([ROW]);
  });

  it("keeps a stored row identity", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "one", name: "Morning", rows: [{ track: TRACK, uid: "row-a" }], isPublic: false },
      ]),
    );
    expect(loadPlaylists()[0].rows).toEqual([{ track: TRACK, uid: "row-a" }]);
  });

  it("drops a malformed row", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "one",
          name: "Morning",
          rows: [{ track: TRACK }, { track: { uri: 5 } }, {}, null],
          isPublic: false,
        },
      ]),
    );
    expect(loadPlaylists()[0].rows).toEqual([ROW]);
  });

  it("drops an empty uid rather than storing one Spotify cannot address", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "one", name: "Morning", rows: [{ track: TRACK, uid: "" }], isPublic: false },
      ]),
    );
    expect(loadPlaylists()[0].rows[0].uid).toBeUndefined();
  });

  /**
   * Stored before lengths were kept. Zero is the honest answer — the length is
   * genuinely unknown — and the enqueue path looks one up rather than sending
   * a zero the server would run out instantly.
   */
  it("loads a track stored without a length as length zero", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "one",
          name: "Morning",
          rows: [{ track: { uri: TRACK.uri, trackId: TRACK.trackId } }],
          isPublic: false,
        },
      ]),
    );
    expect(loadPlaylists()[0].rows[0].track.durationMs).toBe(0);
  });

  it("refuses a stored length that is not a positive number", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "one",
          name: "Morning",
          rows: [
            { track: { ...TRACK, durationMs: "long" } },
            { track: { ...TRACK, trackId: "b", durationMs: -5 } },
          ],
          isPublic: false,
        },
      ]),
    );
    expect(loadPlaylists()[0].rows.map((row) => row.track.durationMs)).toEqual([0, 0]);
  });

  it("skips a playlist with neither rows nor tracks", () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: "one", name: "Morning" }]));
    expect(loadPlaylists()).toEqual([]);
  });
});

describe("loadPlaylists and the playlist source", () => {
  it("loads a playlist stored before linking existed as local", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "one", name: "Morning", rows: [], isPublic: false }]),
    );
    expect(loadPlaylists()[0].source).toEqual(LOCAL);
  });

  it("keeps a stored link", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "one", name: "Morning", rows: [], isPublic: false, source: LINK }]),
    );
    expect(loadPlaylists()[0].source).toEqual(LINK);
  });

  it("round-trips a linked playlist", () => {
    const lists = [
      {
        id: "one",
        name: "From Spotify",
        rows: [{ track: TRACK, uid: "row-a" }],
        isPublic: false,
        source: LINK,
      },
    ];
    savePlaylists(lists);
    expect(loadPlaylists()).toEqual(lists);
  });

  /**
   * Stored before a permission was tracked. Refused until a sync says
   * otherwise: offering a write Spotify will reject is the worse mistake.
   */
  it("loads a link stored without permissions as neither addable nor editable", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "one",
          name: "From Spotify",
          rows: [],
          isPublic: false,
          source: { kind: "spotify", playlistId: "pppp1111", syncedAt: 1000 },
        },
      ]),
    );
    expect(loadPlaylists()[0].source).toEqual({ ...LINK, canAdd: false, canEditItems: false });
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
        { id: "a", name: "No id", rows: [], isPublic: false, source: { kind: "spotify" } },
        {
          id: "b",
          name: "Empty id",
          rows: [],
          isPublic: false,
          source: { kind: "spotify", playlistId: "" },
        },
        { id: "c", name: "Nonsense", rows: [], isPublic: false, source: "spotify" },
        { id: "d", name: "Null", rows: [], isPublic: false, source: null },
      ]),
    );
    for (const list of loadPlaylists()) {
      expect(list.source).toEqual(LOCAL);
    }
  });
});
