import { describe, expect, it } from "vitest";
import {
  INTERNAL_DRAG_MIME,
  linksFromDrop,
  tracksFromDrop,
  type DropData,
} from "./drop-links";

const LINK_A = "https://open.spotify.com/track/aaaa1111";
const LINK_B = "https://open.spotify.com/track/bbbb2222";
const PLAYLIST_LINK = "https://open.spotify.com/playlist/pppp1111";

function drop(payload: Record<string, string>, types?: readonly string[]): DropData {
  return {
    getData: (type) => payload[type] ?? "",
    types: types ?? Object.keys(payload),
  };
}

describe("tracksFromDrop", () => {
  it("reads links from text/uri-list", () => {
    const data = drop({ "text/uri-list": `${LINK_A}\n${LINK_B}` });
    expect(tracksFromDrop(data).map((t) => t.trackId)).toEqual(["aaaa1111", "bbbb2222"]);
  });

  it("reads links from text/plain when uri-list is absent", () => {
    const data = drop({ "text/plain": LINK_B });
    expect(tracksFromDrop(data).map((t) => t.trackId)).toEqual(["bbbb2222"]);
  });

  it("unions both types and dedupes across them", () => {
    const data = drop({
      "text/uri-list": `${LINK_A}\n${LINK_B}`,
      "text/plain": `${LINK_B}\nhttps://open.spotify.com/track/cccc3333`,
    });
    expect(tracksFromDrop(data).map((t) => t.trackId)).toEqual([
      "aaaa1111",
      "bbbb2222",
      "cccc3333",
    ]);
  });

  it("ignores uri-list comment lines", () => {
    const data = drop({ "text/uri-list": `# a comment\n${LINK_A}` });
    expect(tracksFromDrop(data).map((t) => t.trackId)).toEqual(["aaaa1111"]);
  });

  it("returns nothing for an internal spotjam drag, even with link text", () => {
    const data = drop(
      { [INTERNAL_DRAG_MIME]: "item-7", "text/plain": LINK_A },
      [INTERNAL_DRAG_MIME, "text/plain"],
    );
    expect(tracksFromDrop(data)).toEqual([]);
  });

  it("returns nothing when neither type carries a track", () => {
    expect(tracksFromDrop(drop({ "text/plain": "just some words" }))).toEqual([]);
    expect(tracksFromDrop(drop({}))).toEqual([]);
  });

  it("survives a getData that throws for an absent type", () => {
    const data: DropData = {
      types: ["text/plain"],
      getData: (type) => {
        if (type !== "text/plain") throw new Error("no such type");
        return LINK_A;
      },
    };
    expect(tracksFromDrop(data).map((t) => t.trackId)).toEqual(["aaaa1111"]);
  });

  it("works when types is undefined", () => {
    const data: DropData = { getData: (type) => (type === "text/plain" ? LINK_A : "") };
    expect(tracksFromDrop(data).map((t) => t.trackId)).toEqual(["aaaa1111"]);
  });

  it("ignores a playlist-only drop", () => {
    expect(tracksFromDrop(drop({ "text/plain": PLAYLIST_LINK }))).toEqual([]);
  });
});

describe("linksFromDrop", () => {
  it("splits a mixed track-and-playlist drop", () => {
    const data = drop({ "text/plain": `${LINK_A}\n${PLAYLIST_LINK}\n${LINK_B}` });
    const links = linksFromDrop(data);
    expect(links.tracks.map((t) => t.trackId)).toEqual(["aaaa1111", "bbbb2222"]);
    expect(links.playlists.map((p) => p.playlistId)).toEqual(["pppp1111"]);
  });

  it("unions uri-list and text/plain across both kinds", () => {
    const data = drop({
      "text/uri-list": PLAYLIST_LINK,
      "text/plain": `${LINK_A} spotify:playlist:qqqq2222`,
    });
    const links = linksFromDrop(data);
    expect(links.tracks.map((t) => t.trackId)).toEqual(["aaaa1111"]);
    expect(links.playlists.map((p) => p.playlistId)).toEqual(["pppp1111", "qqqq2222"]);
  });

  it("returns nothing for an internal spotjam drag", () => {
    const data = drop(
      { [INTERNAL_DRAG_MIME]: "item-7", "text/plain": PLAYLIST_LINK },
      [INTERNAL_DRAG_MIME, "text/plain"],
    );
    expect(linksFromDrop(data)).toEqual({ tracks: [], playlists: [], albums: [], artists: [] });
  });

  it("returns four empty lists when the payload carries neither kind", () => {
    expect(linksFromDrop(drop({ "text/plain": "just some words" }))).toEqual({
      tracks: [],
      playlists: [],
      albums: [],
      artists: [],
    });
  });

  it("splits album and artist links out of a drop", () => {
    const data = drop({
      "text/plain": `https://open.spotify.com/album/eeee5555\nhttps://open.spotify.com/artist/ffff6666`,
    });
    const links = linksFromDrop(data);
    expect(links.albums.map((a) => a.albumId)).toEqual(["eeee5555"]);
    expect(links.artists.map((a) => a.artistId)).toEqual(["ffff6666"]);
  });
});
