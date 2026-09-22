import { describe, expect, it } from "vitest";
import type { ParsedTrack } from "./spotify-link";
import {
  canAddTracks,
  canEditItems,
  createPlaylist,
  createPlaylistWithTracks,
  deletePlaylist,
  insertTracksIntoPlaylist,
  isEditable,
  linkedPlaylistId,
  moveRowInPlaylist,
  reconcileLinked,
  removeTrackFromPlaylist,
  renamePlaylist,
  rowsOfTracks,
  setPlaylistPublic,
  shufflePlaylist,
  toSharedPlaylists,
  tracksOf,
  unlinkPlaylist,
  type Playlist,
  type PlaylistRow,
} from "./playlists";

const TRACK_A: ParsedTrack = { uri: "spotify:track:aaaa1111", trackId: "aaaa1111" };
const TRACK_B: ParsedTrack = { uri: "spotify:track:bbbb2222", trackId: "bbbb2222" };
const TRACK_C: ParsedTrack = { uri: "spotify:track:cccc3333", trackId: "cccc3333" };

const LOCAL = { kind: "local" } as const;

function lists(): Playlist[] {
  return [
    { id: "one", name: "Morning", rows: rowsOfTracks([TRACK_A]), isPublic: false, source: LOCAL },
    { id: "two", name: "Evening", rows: [], isPublic: false, source: LOCAL },
  ];
}

/** A collection whose second playlist mirrors a Spotify playlist. */
function withLinked(
  perms: { canAdd?: boolean; canEditItems?: boolean } = {},
): Playlist[] {
  return [
    lists()[0],
    {
      id: "linked",
      name: "From Spotify",
      rows: [{ track: TRACK_A, uid: "row-a" }],
      isPublic: false,
      source: {
        kind: "spotify",
        playlistId: "pppp1111",
        syncedAt: 1000,
        canAdd: perms.canAdd ?? true,
        canEditItems: perms.canEditItems ?? true,
      },
    },
  ];
}

/** The track ids a playlist holds, in order. */
function idsOf(playlist: Playlist): string[] {
  return playlist.rows.map((row) => row.track.trackId);
}

describe("createPlaylistWithTracks", () => {
  it("appends a playlist that already holds the rows", () => {
    const next = createPlaylistWithTracks(lists(), "Imported", rowsOfTracks([TRACK_A, TRACK_B]), "three");
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({
      id: "three",
      name: "Imported",
      rows: rowsOfTracks([TRACK_A, TRACK_B]),
      isPublic: false,
      source: LOCAL,
    });
  });

  it("creates a linked playlist when given a Spotify source", () => {
    const source = {
      kind: "spotify",
      playlistId: "pppp1111",
      syncedAt: 50,
      canAdd: true,
      canEditItems: true,
    } as const;
    const next = createPlaylistWithTracks(lists(), "Linked", rowsOfTracks([TRACK_A]), "three", source);
    expect(next[2].source).toEqual(source);
    expect(isEditable(next[2])).toBe(false);
  });

  it("keeps each row's Spotify identity", () => {
    const rows: PlaylistRow[] = [{ track: TRACK_A, uid: "row-a" }];
    expect(createPlaylistWithTracks([], "Linked", rows, "x")[0].rows[0].uid).toBe("row-a");
  });

  it("allows a name that already exists", () => {
    const next = createPlaylistWithTracks(lists(), "Morning", rowsOfTracks([TRACK_B]), "three");
    expect(next.filter((l) => l.name === "Morning")).toHaveLength(2);
  });

  it("accepts an empty row list", () => {
    expect(createPlaylistWithTracks([], "Empty", [], "x")[0].rows).toEqual([]);
  });

  it("drops a track listed twice in the import", () => {
    const next = createPlaylistWithTracks([], "Imported", rowsOfTracks([TRACK_A, TRACK_B, TRACK_A]), "x");
    expect(idsOf(next[0])).toEqual([TRACK_A.trackId, TRACK_B.trackId]);
  });

  it("does not mutate the input lists or the row array", () => {
    const before = lists();
    const rows = rowsOfTracks([TRACK_A]);
    const next = createPlaylistWithTracks(before, "New", rows, "three");
    expect(before).toHaveLength(2);
    next[2].rows.push({ track: TRACK_B });
    expect(rows).toHaveLength(1);
  });
});

describe("createPlaylist", () => {
  it("appends a playlist with the given id and trimmed name", () => {
    const next = createPlaylist(lists(), "  Late night  ", "three");
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({
      id: "three",
      name: "Late night",
      rows: [],
      isPublic: false,
      source: LOCAL,
    });
  });

  it("falls back to Untitled for a blank name", () => {
    expect(createPlaylist([], "   ", "x")[0].name).toBe("Untitled");
  });

  it("mints an id when none is given", () => {
    const [made] = createPlaylist([], "Mix");
    expect(made.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("does not mutate the input", () => {
    const before = lists();
    createPlaylist(before, "New", "three");
    expect(before).toEqual(lists());
  });
});

describe("tracksOf", () => {
  it("drops the row identities, keeping order", () => {
    expect(tracksOf(withLinked()[1])).toEqual([TRACK_A]);
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
    expect(idsOf(next[0])).toEqual([TRACK_A.trackId, TRACK_B.trackId]);
  });

  it("keeps the existing row, not the incoming track, for a duplicate", () => {
    const relinked: ParsedTrack = {
      uri: "https://open.spotify.com/track/aaaa1111",
      trackId: "aaaa1111",
    };
    const next = insertTracksIntoPlaylist(lists(), "one", [relinked], null);
    expect(next[0].rows).toEqual(rowsOfTracks([TRACK_A]));
  });

  it("lands a track listed twice in one batch once, at its first position", () => {
    const next = insertTracksIntoPlaylist(lists(), "two", [TRACK_B, TRACK_A, TRACK_B], null);
    expect(idsOf(next[1])).toEqual([TRACK_B.trackId, TRACK_A.trackId]);
  });

  it("inserts before the named track", () => {
    const seeded = insertTracksIntoPlaylist(lists(), "one", [TRACK_C], null);
    const next = insertTracksIntoPlaylist(seeded, "one", [TRACK_B], "cccc3333");
    expect(idsOf(next[0])).toEqual([TRACK_A.trackId, TRACK_B.trackId, TRACK_C.trackId]);
  });

  it("appends at the end when beforeTrackId is not found", () => {
    const next = insertTracksIntoPlaylist(lists(), "one", [TRACK_B], "missing");
    expect(idsOf(next[0])).toEqual([TRACK_A.trackId, TRACK_B.trackId]);
  });

  it("gives an inserted track no Spotify identity", () => {
    const next = insertTracksIntoPlaylist(lists(), "one", [TRACK_B], null);
    expect(next[0].rows[1].uid).toBeUndefined();
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
    expect(idsOf(before[0])).toEqual([TRACK_A.trackId]);
  });
});

describe("moveRowInPlaylist", () => {
  function three(): Playlist[] {
    return [
      {
        id: "one",
        name: "Morning",
        rows: rowsOfTracks([TRACK_A, TRACK_B, TRACK_C]),
        isPublic: false,
        source: LOCAL,
      },
    ];
  }

  it("moves a row before the named track", () => {
    const next = moveRowInPlaylist(three(), "one", TRACK_C.trackId, TRACK_A.trackId);
    expect(idsOf(next[0])).toEqual([TRACK_C.trackId, TRACK_A.trackId, TRACK_B.trackId]);
  });

  it("moves a row to the end when beforeTrackId is null", () => {
    const next = moveRowInPlaylist(three(), "one", TRACK_A.trackId, null);
    expect(idsOf(next[0])).toEqual([TRACK_B.trackId, TRACK_C.trackId, TRACK_A.trackId]);
  });

  it("moves a row forward past the one it lands before", () => {
    const next = moveRowInPlaylist(three(), "one", TRACK_A.trackId, TRACK_C.trackId);
    expect(idsOf(next[0])).toEqual([TRACK_B.trackId, TRACK_A.trackId, TRACK_C.trackId]);
  });

  it("carries the row's Spotify identity with it", () => {
    const linked = withLinked();
    const seeded = insertTracksIntoPlaylist(linked, "linked", [TRACK_B], null);
    const next = moveRowInPlaylist(seeded, "linked", TRACK_A.trackId, null);
    expect(next[1].rows[1].uid).toBe("row-a");
  });

  it("is a no-op when the row is already there", () => {
    const before = three();
    expect(moveRowInPlaylist(before, "one", TRACK_C.trackId, null)[0]).toBe(before[0]);
    expect(moveRowInPlaylist(before, "one", TRACK_A.trackId, TRACK_B.trackId)[0]).toBe(before[0]);
  });

  it("is a no-op for an unknown row, an unknown playlist, or a move onto itself", () => {
    const before = three();
    expect(moveRowInPlaylist(before, "one", "missing", null)[0]).toBe(before[0]);
    expect(moveRowInPlaylist(before, "missing", TRACK_A.trackId, null)).toEqual(three());
    expect(moveRowInPlaylist(before, "one", TRACK_A.trackId, TRACK_A.trackId)).toBe(before);
  });

  it("treats an unknown destination as the end", () => {
    const next = moveRowInPlaylist(three(), "one", TRACK_A.trackId, "missing");
    expect(idsOf(next[0])).toEqual([TRACK_B.trackId, TRACK_C.trackId, TRACK_A.trackId]);
  });

  it("never mutates", () => {
    const before = three();
    moveRowInPlaylist(before, "one", TRACK_C.trackId, TRACK_A.trackId);
    expect(idsOf(before[0])).toEqual([TRACK_A.trackId, TRACK_B.trackId, TRACK_C.trackId]);
  });
});

describe("removeTrackFromPlaylist", () => {
  it("removes the row at the index", () => {
    const seeded = insertTracksIntoPlaylist(lists(), "one", [TRACK_B], null);
    const next = removeTrackFromPlaylist(seeded, "one", 0);
    expect(idsOf(next[0])).toEqual([TRACK_B.trackId]);
  });

  it("ignores an out-of-range index and never mutates", () => {
    const before = lists();
    expect(removeTrackFromPlaylist(before, "one", 5)).toEqual(lists());
    expect(removeTrackFromPlaylist(before, "one", -1)).toEqual(lists());
    expect(idsOf(before[0])).toEqual([TRACK_A.trackId]);
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
    expect([...idsOf(next[0])].sort()).toEqual([TRACK_A.trackId, TRACK_B.trackId].sort());
    expect(idsOf(before[0])).toEqual([TRACK_A.trackId]);
  });

  it("is a no-op below two rows or for an unknown id", () => {
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
    // A playlist spotjam creates is local, so it is editable.
    expect(isEditable(createPlaylist(lists(), "Mine", "three")[2])).toBe(true);
  });
});

describe("linkedPlaylistId", () => {
  it("returns the mirrored id, or null for a local playlist", () => {
    expect(linkedPlaylistId(withLinked()[1])).toBe("pppp1111");
    expect(linkedPlaylistId(lists()[0])).toBeNull();
  });
});

describe("canAddTracks", () => {
  it("is true for a local playlist", () => {
    expect(canAddTracks(lists()[0])).toBe(true);
  });

  /** A link can point at anyone's playlist; only its owner may write. */
  it("follows the link's permission for a linked playlist", () => {
    expect(canAddTracks(withLinked({ canAdd: true })[1])).toBe(true);
    expect(canAddTracks(withLinked({ canAdd: false })[1])).toBe(false);
  });
});

describe("canEditItems", () => {
  it("is true for a local playlist", () => {
    expect(canEditItems(lists()[0])).toBe(true);
  });

  /** Spotify tracks this apart from adding, so the two can disagree. */
  it("follows the link's own permission, not the add one", () => {
    expect(canEditItems(withLinked({ canAdd: true, canEditItems: false })[1])).toBe(false);
    expect(canEditItems(withLinked({ canAdd: false, canEditItems: true })[1])).toBe(true);
  });
});

describe("reconcileLinked", () => {
  const fetched = {
    name: "Renamed in Spotify",
    rows: [
      { track: TRACK_B, uid: "row-b" },
      { track: TRACK_C, uid: "row-c" },
    ],
    canAdd: true,
    canEditItems: true,
  };

  it("replaces name and rows and stamps the sync time", () => {
    const next = reconcileLinked(withLinked(), "linked", fetched, 2000);
    expect(next[1].name).toBe("Renamed in Spotify");
    expect(next[1].rows).toEqual(fetched.rows);
    expect(next[1].source).toEqual({
      kind: "spotify",
      playlistId: "pppp1111",
      syncedAt: 2000,
      canAdd: true,
      canEditItems: true,
    });
  });

  /** Fresh uids are what keep a later remove or move addressing real rows. */
  it("takes the row identities from the fetch", () => {
    const next = reconcileLinked(withLinked(), "linked", fetched, 2000);
    expect(next[1].rows.map((row) => row.uid)).toEqual(["row-b", "row-c"]);
  });

  /** Spotify owns the content, so a track removed there is removed here. */
  it("drops rows the fetch no longer carries", () => {
    const next = reconcileLinked(withLinked(), "linked", { name: "Empty", rows: [] }, 2000);
    expect(next[1].rows).toEqual([]);
  });

  it("keeps the current name when the fetch carries none", () => {
    const next = reconcileLinked(withLinked(), "linked", { name: "   ", rows: [] }, 2000);
    expect(next[1].name).toBe("From Spotify");
  });

  it("lands a track listed twice once", () => {
    const next = reconcileLinked(
      withLinked(),
      "linked",
      { name: "Dupes", rows: [{ track: TRACK_B, uid: "row-b" }, { track: TRACK_B, uid: "row-b2" }] },
      2000,
    );
    expect(next[1].rows).toEqual([{ track: TRACK_B, uid: "row-b" }]);
  });

  it("keeps the playlist public when it already was", () => {
    const shared = setPlaylistPublic(withLinked(), "linked", true);
    expect(reconcileLinked(shared, "linked", fetched, 2000)[1].isPublic).toBe(true);
  });

  /** Access can open up or be withdrawn, so each sync restates both flags. */
  it("restates the permissions from the fetch", () => {
    const opened = reconcileLinked(
      withLinked({ canAdd: false, canEditItems: false }),
      "linked",
      fetched,
      2000,
    );
    expect(canAddTracks(opened[1])).toBe(true);
    expect(canEditItems(opened[1])).toBe(true);

    const closed = reconcileLinked(
      withLinked(),
      "linked",
      { ...fetched, canAdd: false, canEditItems: false },
      2000,
    );
    expect(canAddTracks(closed[1])).toBe(false);
    expect(canEditItems(closed[1])).toBe(false);
  });

  it("treats a fetch with no permissions as neither addable nor editable", () => {
    const next = reconcileLinked(withLinked(), "linked", { name: "X", rows: [] }, 2000);
    expect(canAddTracks(next[1])).toBe(false);
    expect(canEditItems(next[1])).toBe(false);
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
    expect(idsOf(before[1])).toEqual([TRACK_A.trackId]);
    expect(before[1].name).toBe("From Spotify");
  });
});

describe("unlinkPlaylist", () => {
  it("keeps the tracks and makes the playlist editable", () => {
    const next = unlinkPlaylist(withLinked(), "linked");
    expect(idsOf(next[1])).toEqual([TRACK_A.trackId]);
    expect(next[1].name).toBe("From Spotify");
    expect(isEditable(next[1])).toBe(true);
  });

  /** The uids name rows in a playlist this one no longer follows. */
  it("drops the Spotify row identities", () => {
    expect(unlinkPlaylist(withLinked(), "linked")[1].rows[0].uid).toBeUndefined();
  });

  it("returns the same playlist for a local one or an unknown id", () => {
    const before = lists();
    expect(unlinkPlaylist(before, "one")[0]).toBe(before[0]);
    expect(unlinkPlaylist(before, "missing")).toEqual(lists());
  });

  it("never mutates", () => {
    const before = withLinked();
    unlinkPlaylist(before, "linked");
    expect(before[1].rows[0].uid).toBe("row-a");
    expect(before[1].source).toEqual({
      kind: "spotify",
      playlistId: "pppp1111",
      syncedAt: 1000,
      canAdd: true,
      canEditItems: true,
    });
  });
});

describe("toSharedPlaylists with a linked playlist", () => {
  /** Peers see an ordinary playlist: the link and the uids are local state. */
  it("projects the link and the row identities away", () => {
    const shared = toSharedPlaylists(setPlaylistPublic(withLinked(), "linked", true));
    expect(shared).toEqual([
      {
        id: "linked",
        name: "From Spotify",
        tracks: [{ uri: TRACK_A.uri, trackId: TRACK_A.trackId }],
      },
    ]);
  });
});
