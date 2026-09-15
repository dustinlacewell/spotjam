import { describe, expect, it } from "vitest";
import type { ParsedTrack } from "./spotify-link";
import {
  addTracksToPlaylist,
  createPlaylist,
  createPlaylistWithTracks,
  deletePlaylist,
  removeTrackFromPlaylist,
  renamePlaylist,
  setPlaylistPublic,
  shufflePlaylist,
  toSharedPlaylists,
  type Playlist,
} from "./playlists";

const TRACK_A: ParsedTrack = { uri: "spotify:track:aaaa1111", trackId: "aaaa1111" };
const TRACK_B: ParsedTrack = { uri: "spotify:track:bbbb2222", trackId: "bbbb2222" };

function lists(): Playlist[] {
  return [
    { id: "one", name: "Morning", tracks: [TRACK_A], isPublic: false },
    { id: "two", name: "Evening", tracks: [], isPublic: false },
  ];
}

describe("createPlaylistWithTracks", () => {
  it("appends a playlist that already holds the tracks", () => {
    const next = createPlaylistWithTracks(lists(), "Imported", [TRACK_A, TRACK_B], "three");
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({
      id: "three",
      name: "Imported",
      tracks: [TRACK_A, TRACK_B],
      isPublic: false,
    });
  });

  it("allows a name that already exists", () => {
    const next = createPlaylistWithTracks(lists(), "Morning", [TRACK_B], "three");
    expect(next.filter((l) => l.name === "Morning")).toHaveLength(2);
  });

  it("accepts an empty track list", () => {
    expect(createPlaylistWithTracks([], "Empty", [], "x")[0].tracks).toEqual([]);
  });

  it("drops a track listed twice in the import", () => {
    const next = createPlaylistWithTracks([], "Imported", [TRACK_A, TRACK_B, TRACK_A], "x");
    expect(next[0].tracks).toEqual([TRACK_A, TRACK_B]);
  });

  it("does not mutate the input lists or the track array", () => {
    const before = lists();
    const tracks = [TRACK_A];
    const next = createPlaylistWithTracks(before, "New", tracks, "three");
    expect(before).toHaveLength(2);
    next[2].tracks.push(TRACK_B);
    expect(tracks).toEqual([TRACK_A]);
  });
});

describe("createPlaylist", () => {
  it("appends a playlist with the given id and trimmed name", () => {
    const next = createPlaylist(lists(), "  Late night  ", "three");
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ id: "three", name: "Late night", tracks: [], isPublic: false });
  });

  it("creates a playlist private", () => {
    expect(createPlaylist(lists(), "Secret", "three")[2].isPublic).toBe(false);
  });

  it("falls back to Untitled for a blank name", () => {
    expect(createPlaylist([], "   ", "x")[0].name).toBe("Untitled");
  });

  it("mints an id when none is given", () => {
    const [made] = createPlaylist([], "Mix");
    expect(made.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("does not mutate the input", () => {
    const before = lists();
    createPlaylist(before, "New", "three");
    expect(before).toEqual(lists());
  });
});

describe("deletePlaylist", () => {
  it("removes the named playlist", () => {
    expect(deletePlaylist(lists(), "one").map((l) => l.id)).toEqual(["two"]);
  });

  it("is a no-op for an unknown id and never mutates", () => {
    const before = lists();
    expect(deletePlaylist(before, "missing")).toEqual(lists());
    expect(before).toEqual(lists());
  });
});

describe("renamePlaylist", () => {
  it("trims and applies the new name", () => {
    const next = renamePlaylist(lists(), "two", "  Night  ");
    expect(next[1].name).toBe("Night");
    expect(next[0]).toEqual(lists()[0]);
  });

  it("ignores an empty or whitespace name", () => {
    const before = lists();
    expect(renamePlaylist(before, "one", "")).toEqual(lists());
    expect(renamePlaylist(before, "one", "   ")).toEqual(lists());
    expect(before).toEqual(lists());
  });

  it("does not mutate the renamed playlist object", () => {
    const before = lists();
    const next = renamePlaylist(before, "one", "Dawn");
    expect(before[0].name).toBe("Morning");
    expect(next[0]).not.toBe(before[0]);
  });
});

describe("addTracksToPlaylist", () => {
  it("appends tracks and skips one the playlist already holds", () => {
    const next = addTracksToPlaylist(lists(), "one", [TRACK_A, TRACK_B]);
    expect(next[0].tracks).toEqual([TRACK_A, TRACK_B]);
  });

  it("keeps the existing entry, not the incoming one, for a duplicate", () => {
    const relinked: ParsedTrack = { uri: "https://open.spotify.com/track/aaaa1111", trackId: "aaaa1111" };
    const next = addTracksToPlaylist(lists(), "one", [relinked]);
    expect(next[0].tracks).toEqual([TRACK_A]);
  });

  it("lands a track listed twice in one batch once, at its first position", () => {
    const next = addTracksToPlaylist(lists(), "two", [TRACK_B, TRACK_A, TRACK_B]);
    expect(next[1].tracks).toEqual([TRACK_B, TRACK_A]);
  });

  it("returns the same playlist object when every track is already held", () => {
    const before = lists();
    expect(addTracksToPlaylist(before, "one", [TRACK_A])[0]).toBe(before[0]);
  });

  it("leaves other playlists alone", () => {
    const before = lists();
    const next = addTracksToPlaylist(before, "one", [TRACK_B]);
    expect(next[1]).toBe(before[1]);
    expect(before[0].tracks).toEqual([TRACK_A]);
  });

  it("is a no-op for an empty track list or unknown id", () => {
    expect(addTracksToPlaylist(lists(), "one", [])).toEqual(lists());
    expect(addTracksToPlaylist(lists(), "missing", [TRACK_B])).toEqual(lists());
  });
});

describe("removeTrackFromPlaylist", () => {
  it("removes the track at the index", () => {
    const seeded = addTracksToPlaylist(lists(), "one", [TRACK_B]);
    const next = removeTrackFromPlaylist(seeded, "one", 0);
    expect(next[0].tracks).toEqual([TRACK_B]);
  });

  it("ignores an out-of-range index and never mutates", () => {
    const before = lists();
    expect(removeTrackFromPlaylist(before, "one", 5)).toEqual(lists());
    expect(removeTrackFromPlaylist(before, "one", -1)).toEqual(lists());
    expect(before[0].tracks).toEqual([TRACK_A]);
  });

  it("ignores an unknown playlist id", () => {
    expect(removeTrackFromPlaylist(lists(), "missing", 0)).toEqual(lists());
  });
});

describe("shufflePlaylist", () => {
  it("keeps the same tracks and never mutates", () => {
    const before = lists();
    const seeded = addTracksToPlaylist(before, "one", [TRACK_B]);
    const next = shufflePlaylist(seeded, "one");
    expect([...next[0].tracks].sort(byId)).toEqual([TRACK_A, TRACK_B].sort(byId));
    expect(before[0].tracks).toEqual([TRACK_A]);
  });

  it("leaves other playlists alone", () => {
    const next = shufflePlaylist(lists(), "one");
    expect(next[1]).toEqual(lists()[1]);
  });

  it("is a no-op below two tracks or for an unknown id", () => {
    expect(shufflePlaylist(lists(), "one")).toEqual(lists());
    expect(shufflePlaylist(lists(), "two")).toEqual(lists());
    expect(shufflePlaylist(lists(), "missing")).toEqual(lists());
  });
});

describe("setPlaylistPublic", () => {
  it("sets the flag on the named playlist and never mutates", () => {
    const before = lists();
    const next = setPlaylistPublic(before, "one", true);
    expect(next[0].isPublic).toBe(true);
    expect(before[0].isPublic).toBe(false);
  });

  it("takes a public playlist back", () => {
    const shared = setPlaylistPublic(lists(), "one", true);
    expect(setPlaylistPublic(shared, "one", false)[0].isPublic).toBe(false);
  });

  it("leaves other playlists alone", () => {
    expect(setPlaylistPublic(lists(), "one", true)[1]).toEqual(lists()[1]);
  });

  it("returns the same array for an unknown id or an unchanged flag", () => {
    const before = lists();
    expect(setPlaylistPublic(before, "missing", true)).toEqual(lists());
    expect(setPlaylistPublic(before, "one", false)[0]).toBe(before[0]);
  });
});

describe("toSharedPlaylists", () => {
  it("keeps only the public ones, in the wire shape", () => {
    const shared = toSharedPlaylists(setPlaylistPublic(lists(), "one", true));
    expect(shared).toEqual([
      { id: "one", name: "Morning", tracks: [{ uri: TRACK_A.uri, trackId: TRACK_A.trackId }] },
    ]);
  });

  it("is empty when nothing is public", () => {
    expect(toSharedPlaylists(lists())).toEqual([]);
  });

  it("carries a public playlist with no tracks", () => {
    const shared = toSharedPlaylists(setPlaylistPublic(lists(), "two", true));
    expect(shared).toEqual([{ id: "two", name: "Evening", tracks: [] }]);
  });
});

function byId(a: ParsedTrack, b: ParsedTrack): number {
  return a.trackId.localeCompare(b.trackId);
}
