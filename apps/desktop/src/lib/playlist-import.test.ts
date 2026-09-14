import { describe, expect, it } from "vitest";
import { importPlaylist, type FetchedPlaylist } from "./playlist-import";

interface Call {
  cmd: string;
  args?: Record<string, unknown>;
}

function fakeInvoke(result: FetchedPlaylist | Error) {
  const calls: Call[] = [];
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (result instanceof Error) throw result;
    return result as T;
  };
  return { calls, invoke };
}

const PLAYLIST: FetchedPlaylist = {
  name: "Late night",
  tracks: [
    { uri: "spotify:track:aaaa1111", name: "One", artist: "A" },
    { uri: "spotify:track:bbbb2222", name: "Two", artist: "B" },
  ],
};

describe("importPlaylist", () => {
  it("calls spotify_fetch_playlist with the uri", async () => {
    const { calls, invoke } = fakeInvoke(PLAYLIST);
    await importPlaylist("spotify:playlist:pppp1111", invoke);
    expect(calls).toEqual([
      { cmd: "spotify_fetch_playlist", args: { uri: "spotify:playlist:pppp1111" } },
    ]);
  });

  it("maps the result to parsed tracks and keeps the name", async () => {
    const { invoke } = fakeInvoke(PLAYLIST);
    expect(await importPlaylist("spotify:playlist:pppp1111", invoke)).toEqual({
      name: "Late night",
      tracks: [
        { uri: "spotify:track:aaaa1111", trackId: "aaaa1111" },
        { uri: "spotify:track:bbbb2222", trackId: "bbbb2222" },
      ],
    });
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
    const imported = await importPlaylist("spotify:playlist:pppp1111", invoke);
    expect(imported.tracks.map((t) => t.trackId)).toEqual(["cccc3333"]);
  });

  it("yields an empty track list for an empty playlist", async () => {
    const { invoke } = fakeInvoke({ name: "Nothing", tracks: [] });
    expect(await importPlaylist("spotify:playlist:pppp1111", invoke)).toEqual({
      name: "Nothing",
      tracks: [],
    });
  });

  it("rejects when the command fails", async () => {
    const { invoke } = fakeInvoke(new Error("no such playlist"));
    await expect(importPlaylist("spotify:playlist:pppp1111", invoke)).rejects.toThrow(
      "no such playlist",
    );
  });
});
