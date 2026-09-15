import { describe, expect, it } from "vitest";
import { PlaylistFetchError } from "@spotjam/room";
import { importPlaylist, type FetchedPlaylist, type FetchFailure } from "./playlist-import";

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

function fakeInvoke(result: FetchedPlaylist | { throws: unknown }) {
  const calls: Call[] = [];
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (result && typeof result === "object" && "throws" in result) throw result.throws;
    return result as T;
  };
  return { calls, invoke };
}

function failing(failure: unknown) {
  return fakeInvoke({ throws: failure }).invoke;
}

const PLAYLIST: FetchedPlaylist = {
  name: "Late night",
  tracks: [
    { uri: "spotify:track:aaaa1111", name: "One", artist: "A" },
    { uri: "spotify:track:bbbb2222", name: "Two", artist: "B" },
  ],
};

const URI = "spotify:playlist:pppp1111";

describe("importPlaylist", () => {
  it("calls spotify_fetch_playlist with the uri", async () => {
    const { calls, invoke } = fakeInvoke(PLAYLIST);
    await importPlaylist(URI, invoke);
    expect(calls).toEqual([{ cmd: "spotify_fetch_playlist", args: { uri: URI } }]);
  });

  it("maps the result to parsed tracks and keeps the name", async () => {
    const { invoke } = fakeInvoke(PLAYLIST);
    expect(await importPlaylist(URI, invoke)).toEqual({
      playlistId: "pppp1111",
      name: "Late night",
      tracks: [
        { uri: "spotify:track:aaaa1111", trackId: "aaaa1111" },
        { uri: "spotify:track:bbbb2222", trackId: "bbbb2222" },
      ],
    });
  });

  it("carries the playlist id through, so the playlist can stay linked", async () => {
    const { invoke } = fakeInvoke(PLAYLIST);
    const imported = await importPlaylist(
      "https://open.spotify.com/playlist/qqqq2222?si=abc",
      invoke,
    );
    expect(imported.playlistId).toBe("qqqq2222");
  });

  it("filters entries whose uri is not a track", async () => {
    const { invoke } = fakeInvoke({
      name: "Mixed",
      tracks: [
        { uri: "spotify:local:x:y:z", name: "Local", artist: "L" },
        { uri: "spotify:episode:eeee5555", name: "Pod", artist: "P" },
        { uri: "spotify:track:cccc3333", name: "Real", artist: "C" },
        { uri: "spotify:track:", name: "Empty id", artist: "E" },
      ],
    });
    const imported = await importPlaylist(URI, invoke);
    expect(imported.tracks.map((t) => t.trackId)).toEqual(["cccc3333"]);
  });

  it("yields an empty track list for an empty playlist", async () => {
    const { invoke } = fakeInvoke({ name: "Nothing", tracks: [] });
    expect(await importPlaylist(URI, invoke)).toEqual({
      playlistId: "pppp1111",
      name: "Nothing",
      tracks: [],
    });
  });

  it("rejects a link that is not a playlist without calling the command", async () => {
    const { calls, invoke } = fakeInvoke(PLAYLIST);
    await expect(importPlaylist("spotify:track:aaaa1111", invoke)).rejects.toBeInstanceOf(
      PlaylistFetchError,
    );
    expect(calls).toEqual([]);
  });
});

describe("importPlaylist failures", () => {
  it("reports a gone playlist as gone", async () => {
    const failure: FetchFailure = { kind: "gone", message: "Invalid playlist or members response!" };
    await expect(importPlaylist(URI, failing(failure))).rejects.toMatchObject({ reason: "gone" });
  });

  it("reports an unreachable client as unreachable", async () => {
    const failure: FetchFailure = { kind: "unreachable", message: "Failed to fetch" };
    await expect(importPlaylist(URI, failing(failure))).rejects.toMatchObject({
      reason: "unreachable",
    });
  });

  /**
   * The safe direction. An untagged rejection must never read as "gone", or a
   * client hiccup would silently delete the user's linked playlists.
   */
  it("treats an untagged rejection as unreachable", async () => {
    await expect(importPlaylist(URI, failing(new Error("boom")))).rejects.toMatchObject({
      reason: "unreachable",
      message: "boom",
    });
    await expect(importPlaylist(URI, failing("some string"))).rejects.toMatchObject({
      reason: "unreachable",
    });
    await expect(
      importPlaylist(URI, failing({ kind: "something-else", message: "?" })),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("keeps the message Rust sent", async () => {
    const failure: FetchFailure = { kind: "gone", message: "no such playlist" };
    await expect(importPlaylist(URI, failing(failure))).rejects.toThrow("no such playlist");
  });
});
