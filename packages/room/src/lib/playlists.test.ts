import { describe, expect, it } from "vitest";
import type { ParsedTrack } from "./spotify-link";
import {
  createPlaylist,
  createPlaylistWithTracks,
  deletePlaylist,
  insertTracksIntoPlaylist,
  isEditable,
  linkedPlaylistId,
  reconcileLinked,
  removeTrackFromPlaylist,
  renamePlaylist,
  setPlaylistPublic,
  shufflePlaylist,
  toSharedPlaylists,
  unlinkPlaylist,
  type Playlist,
} from "./playlists";

const TRACK_A: ParsedTrack = { uri: "spotify:track:aaaa1111", trackId: "aaaa1111" };
const TRACK_B: ParsedTrack = { uri: "spotify:track:bbbb2222", trackId: "bbbb2222" };
const TRACK_C: ParsedTrack = { uri: "spotify:track:cccc3333", trackId: "cccc3333" };

const LOCAL = { kind: "local" } as const;

function lists(): Playlist[] {
  return [
    { id: "one", name: "Morning", tracks: [TRACK_A], isPublic: false, source: LOCAL },
    { id: "two", name: "Evening", tracks: [], isPublic: false, source: LOCAL },
  ];
}

/** A collection whose second playlist mirrors a Spotify playlist. */
function withLinked(): Playlist[] {
  return [
    lists()[0],
    {
      id: "linked",
      name: "From Spotify",
      tracks: [TRACK_A],
      isPublic: false,
      source: { kind: "spotify", playlistId: "pppp1111", syncedAt: 1000 },
    },
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
      source: LOCAL,
    });
  });

  it("creates a linked playlist when given a Spotify source", () => {
    const source = { kind: "spotify", playlistId: "pppp1111", syncedAt: 50 } as const;
    const next = createPlaylistWithTracks(lists(), "Linked", [TRACK_A], "three", source);
    expect(next[2].source).toEqual(source);
    expect(isEditable(next[2])).toBe(false);
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
    expect(next[2]).toEqual({
      id: "three",
      name: "Late night",
      tracks: [],
      isPublic: false,
      source: LOCAL,
    });
  });

  it("creates a playlist spotjam owns", () => {
    expect(isEditable(createPlaylist(lists(), "Mine", "three")[2])).toBe(true);
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

describe("insertTracksIntoPlaylist", () => {
  it("appends tracks and skips one the playlist already holds", () => {
    const next = insertTracksIntoPlaylist(lists(), "one", [TRACK_A, TRACK_B], null);
    expect(next[0].tracks).toEqual([TRACK_A, TRACK_B]);
  });

  it("keeps the existing entry, not the incoming one, for a duplicate", () => {
    const relinked: ParsedTrack = { uri: "https://open.spotify.com/track/aaaa1111", trackId: "aaaa1111" };
    const next = insertTracksIntoPlaylist(lists(), "one", [relinked], null);
    expect(next[0].tracks).toEqual([TRACK_A]);
  });

  it("lands a track listed twice in one batch once, at its first position", () => {
    const next = insertTracksIntoPlaylist(lists(), "two", [TRACK_B, TRACK_A, TRACK_B], null);
    expect(next[1].tracks).toEqual([TRACK_B, TRACK_A]);
  });

  it("inserts before the named track", () => {
    const seeded = insertTracksIntoPlaylist(lists(), "one", [TRACK_C], null);
    const next = insertTracksIntoPlaylist(seeded, "one", [TRACK_B], "cccc3333");
    expect(next[0].tracks).toEqual([TRACK_A, TRACK_B, TRACK_C]);
  });

  it("appends at the end when beforeTrackId is not found", () => {
    const next = insertTracksIntoPlaylist(lists(), "one", [TRACK_B], "missing");
    expect(next[0].tracks).toEqual([TRACK_A, TRACK_B]);
  });

  it("is a no-op for an empty track list, an unknown id, or when nothing new arrives", () => {
    expect(insertTracksIntoPlaylist(lists(), "one", [], "x")).toEqual(lists());
    expect(insertTracksIntoPlaylist(lists(), "missing", [TRACK_B], null)).toEqual(lists());
    const before = lists();
    expect(insertTracksIntoPlaylist(before, "one", [TRACK_A], null)[0]).toBe(before[0]);
  });

  it("leaves other playlists alone and never mutates", () => {
    const before = lists();
    const next = insertTracksIntoPlaylist(before, "one", [TRACK_B], null);
    expect(next[1]).toBe(before[1]);
    expect(before[0].tracks).toEqual([TRACK_A]);
  });
});

describe("removeTrackFromPlaylist", () => {
  it("removes the track at the index", () => {
    const seeded = insertTracksIntoPlaylist(lists(), "one", [TRACK_B], null);
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
    const seeded = insertTracksIntoPlaylist(before, "one", [TRACK_B], null);
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

describe("isEditable", () => {
  it("is true for a local playlist and false for a linked one", () => {
    expect(isEditable(lists()[0])).toBe(true);
    expect(isEditable(withLinked()[1])).toBe(false);
  });
});

describe("linkedPlaylistId", () => {
  it("returns the mirrored id, or null for a local playlist", () => {
    expect(linkedPlaylistId(withLinked()[1])).toBe("pppp1111");
    expect(linkedPlaylistId(lists()[0])).toBeNull();
  });
});

describe("reconcileLinked", () => {
  const fetched = { name: "Renamed in Spotify", tracks: [TRACK_B, TRACK_C] };

  it("replaces name and tracks and stamps the sync time", () => {
    const next = reconcileLinked(withLinked(), "linked", fetched, 2000);
    expect(next[1].name).toBe("Renamed in Spotify");
    expect(next[1].tracks).toEqual([TRACK_B, TRACK_C]);
    expect(next[1].source).toEqual({ kind: "spotify", playlistId: "pppp1111", syncedAt: 2000 });
  });

  /** Spotify owns the content, so a track removed there is removed here. */
  it("drops tracks the fetch no longer carries", () => {
    const next = reconcileLinked(withLinked(), "linked", { name: "Empty", tracks: [] }, 2000);
    expect(next[1].tracks).toEqual([]);
  });

  it("keeps the current name when the fetch carries none", () => {
    const next = reconcileLinked(withLinked(), "linked", { name: "   ", tracks: [] }, 2000);
    expect(next[1].name).toBe("From Spotify");
  });

  it("lands a track listed twice once", () => {
    const next = reconcileLinked(
      withLinked(),
      "linked",
      { name: "Dupes", tracks: [TRACK_B, TRACK_C, TRACK_B] },
      2000,
    );
    expect(next[1].tracks).toEqual([TRACK_B, TRACK_C]);
  });

  it("keeps the playlist public when it already was", () => {
    const shared = setPlaylistPublic(withLinked(), "linked", true);
    expect(reconcileLinked(shared, "linked", fetched, 2000)[1].isPublic).toBe(true);
  });

  /**
   * A sync in flight when the user unlinks or deletes must not resurrect the
   * link or overwrite what is now a local playlist.
   */
  it("ignores a local playlist and an unknown id", () => {
    expect(reconcileLinked(lists(), "one", fetched, 2000)).toEqual(lists());
    expect(reconcileLinked(withLinked(), "missing", fetched, 2000)).toEqual(withLinked());
  });

  it("leaves other playlists alone and never mutates", () => {
    const before = withLinked();
    const next = reconcileLinked(before, "linked", fetched, 2000);
    expect(next[0]).toBe(before[0]);
    expect(before[1].tracks).toEqual([TRACK_A]);
    expect(before[1].name).toBe("From Spotify");
  });
});

describe("unlinkPlaylist", () => {
  it("keeps the tracks and makes the playlist editable", () => {
    const next = unlinkPlaylist(withLinked(), "linked");
    expect(next[1].tracks).toEqual([TRACK_A]);
    expect(next[1].name).toBe("From Spotify");
    expect(isEditable(next[1])).toBe(true);
  });

  it("returns the same playlist for a local one or an unknown id", () => {
    const before = lists();
    expect(unlinkPlaylist(before, "one")[0]).toBe(before[0]);
    expect(unlinkPlaylist(before, "missing")).toEqual(lists());
  });

  it("never mutates", () => {
    const before = withLinked();
    unlinkPlaylist(before, "linked");
    expect(before[1].source).toEqual({
      kind: "spotify",
      playlistId: "pppp1111",
      syncedAt: 1000,
    });
  });
});

describe("toSharedPlaylists with a linked playlist", () => {
  /** Peers see an ordinary playlist: the link is install-local state. */
  it("projects the link away", () => {
    const shared = toSharedPlaylists(setPlaylistPublic(withLinked(), "linked", true));
    expect(shared).toEqual([
      { id: "linked", name: "From Spotify", tracks: [{ uri: TRACK_A.uri, trackId: TRACK_A.trackId }] },
    ]);
  });
});

function byId(a: ParsedTrack, b: ParsedTrack): number {
  return a.trackId.localeCompare(b.trackId);
}
