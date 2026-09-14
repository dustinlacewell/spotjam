import { describe, expect, it } from "vitest";
import {
  parseSpotifyLinks,
  parseSpotifyPlaylistLink,
  parseSpotifyTrackLinks,
} from "./spotify-link";

const LINK_A = "https://open.spotify.com/track/aaaa1111";
const LINK_B = "https://open.spotify.com/track/bbbb2222";
const PLAYLIST_URL = "https://open.spotify.com/playlist/pppp1111";

describe("parseSpotifyTrackLinks", () => {
  it("returns nothing for empty or junk-only text", () => {
    expect(parseSpotifyTrackLinks("")).toEqual([]);
    expect(parseSpotifyTrackLinks("   \n  ")).toEqual([]);
    expect(parseSpotifyTrackLinks("hello world https://example.com/track/x")).toEqual([]);
  });

  it("parses a single link the same way as the singular parser", () => {
    expect(parseSpotifyTrackLinks(LINK_A)).toEqual([
      { uri: "spotify:track:aaaa1111", trackId: "aaaa1111" },
    ]);
  });

  it("parses several links split across lines and spaces", () => {
    const text = `${LINK_A}\n${LINK_B}  spotify:track:cccc3333`;
    expect(parseSpotifyTrackLinks(text).map((t) => t.trackId)).toEqual([
      "aaaa1111",
      "bbbb2222",
      "cccc3333",
    ]);
  });

  it("keeps query strings and intl paths working", () => {
    const text = `https://open.spotify.com/intl-de/track/dddd4444?si=abc\n${LINK_A}`;
    expect(parseSpotifyTrackLinks(text).map((t) => t.trackId)).toEqual(["dddd4444", "aaaa1111"]);
  });

  it("dedupes by trackId and keeps first-seen order", () => {
    const text = `${LINK_B}\n${LINK_A}\n${LINK_B}?si=different\nspotify:track:bbbb2222`;
    expect(parseSpotifyTrackLinks(text).map((t) => t.trackId)).toEqual(["bbbb2222", "aaaa1111"]);
  });

  it("drops junk mixed in among valid links", () => {
    const text = `garbage ${LINK_A} https://open.spotify.com/album/zzzz9999 ${LINK_B} 42`;
    expect(parseSpotifyTrackLinks(text).map((t) => t.trackId)).toEqual(["aaaa1111", "bbbb2222"]);
  });

  it("ignores playlist links", () => {
    expect(parseSpotifyTrackLinks(PLAYLIST_URL)).toEqual([]);
  });
});

describe("parseSpotifyPlaylistLink", () => {
  it("parses a share URL", () => {
    expect(parseSpotifyPlaylistLink(PLAYLIST_URL)).toEqual({
      uri: "spotify:playlist:pppp1111",
      playlistId: "pppp1111",
    });
  });

  it("parses a raw playlist URI", () => {
    expect(parseSpotifyPlaylistLink("spotify:playlist:qqqq2222")).toEqual({
      uri: "spotify:playlist:qqqq2222",
      playlistId: "qqqq2222",
    });
  });

  it("ignores an si query parameter", () => {
    expect(parseSpotifyPlaylistLink(`${PLAYLIST_URL}?si=deadbeef`)?.playlistId).toBe("pppp1111");
  });

  it("accepts an intl path prefix", () => {
    const link = "https://open.spotify.com/intl-de/playlist/rrrr3333?si=x";
    expect(parseSpotifyPlaylistLink(link)).toEqual({
      uri: "spotify:playlist:rrrr3333",
      playlistId: "rrrr3333",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseSpotifyPlaylistLink("  spotify:playlist:ssss4444  ")?.playlistId).toBe("ssss4444");
  });

  it("returns null for tracks, albums, junk and empty text", () => {
    expect(parseSpotifyPlaylistLink(LINK_A)).toBeNull();
    expect(parseSpotifyPlaylistLink("spotify:track:aaaa1111")).toBeNull();
    expect(parseSpotifyPlaylistLink("https://open.spotify.com/album/zzzz9999")).toBeNull();
    expect(parseSpotifyPlaylistLink("https://example.com/playlist/xxxx")).toBeNull();
    expect(parseSpotifyPlaylistLink("")).toBeNull();
  });

  it("rejects a playlist URI with trailing junk", () => {
    expect(parseSpotifyPlaylistLink("spotify:playlist:pppp1111:extra")).toBeNull();
  });
});

describe("parseSpotifyLinks", () => {
  it("splits a mixed paste into tracks and playlists", () => {
    const text = `${LINK_A}\n${PLAYLIST_URL}\nspotify:playlist:qqqq2222 ${LINK_B}`;
    const links = parseSpotifyLinks(text);
    expect(links.tracks.map((t) => t.trackId)).toEqual(["aaaa1111", "bbbb2222"]);
    expect(links.playlists.map((p) => p.playlistId)).toEqual(["pppp1111", "qqqq2222"]);
  });

  it("dedupes playlists by id across url and uri forms", () => {
    const text = `${PLAYLIST_URL}?si=one spotify:playlist:pppp1111 ${PLAYLIST_URL}`;
    expect(parseSpotifyLinks(text).playlists.map((p) => p.playlistId)).toEqual(["pppp1111"]);
  });

  it("returns two empty lists for junk", () => {
    expect(parseSpotifyLinks("nothing to see here")).toEqual({ tracks: [], playlists: [] });
  });
});
