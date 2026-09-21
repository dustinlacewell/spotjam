import { describe, expect, it } from "vitest";
import {
  parseSpotifyAlbumLink,
  parseSpotifyArtistLink,
  parseSpotifyLinks,
  parseSpotifyPlaylistLink,
  parseSpotifyTrackLinks,
} from "./spotify-link";

const LINK_A = "https://open.spotify.com/track/aaaa1111";
const LINK_B = "https://open.spotify.com/track/bbbb2222";
const PLAYLIST_URL = "https://open.spotify.com/playlist/pppp1111";
const ALBUM_URL = "https://open.spotify.com/album/eeee5555";
const ARTIST_URL = "https://open.spotify.com/artist/ffff6666";

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

describe("parseSpotifyAlbumLink", () => {
  it("parses a share URL", () => {
    expect(parseSpotifyAlbumLink(ALBUM_URL)).toEqual({
      uri: "spotify:album:eeee5555",
      albumId: "eeee5555",
    });
  });

  it("parses a raw album URI", () => {
    expect(parseSpotifyAlbumLink("spotify:album:gggg7777")).toEqual({
      uri: "spotify:album:gggg7777",
      albumId: "gggg7777",
    });
  });

  it("accepts an intl path prefix and query strings", () => {
    expect(parseSpotifyAlbumLink("https://open.spotify.com/intl-de/album/hhhh8888?si=x")).toEqual({
      uri: "spotify:album:hhhh8888",
      albumId: "hhhh8888",
    });
  });

  it("returns null for tracks, artists, playlists, junk and empty text", () => {
    expect(parseSpotifyAlbumLink(LINK_A)).toBeNull();
    expect(parseSpotifyAlbumLink(ARTIST_URL)).toBeNull();
    expect(parseSpotifyAlbumLink(PLAYLIST_URL)).toBeNull();
    expect(parseSpotifyAlbumLink("spotify:track:aaaa1111")).toBeNull();
    expect(parseSpotifyAlbumLink("https://example.com/album/xxxx")).toBeNull();
    expect(parseSpotifyAlbumLink("")).toBeNull();
  });

  it("rejects an album URI with trailing junk", () => {
    expect(parseSpotifyAlbumLink("spotify:album:eeee5555:extra")).toBeNull();
  });
});

describe("parseSpotifyArtistLink", () => {
  it("parses a share URL", () => {
    expect(parseSpotifyArtistLink(ARTIST_URL)).toEqual({
      uri: "spotify:artist:ffff6666",
      artistId: "ffff6666",
    });
  });

  it("parses a raw artist URI", () => {
    expect(parseSpotifyArtistLink("spotify:artist:iiii9999")).toEqual({
      uri: "spotify:artist:iiii9999",
      artistId: "iiii9999",
    });
  });

  it("accepts an intl path prefix and query strings", () => {
    expect(parseSpotifyArtistLink("https://open.spotify.com/intl-fr/artist/jjjj0000?si=x")).toEqual({
      uri: "spotify:artist:jjjj0000",
      artistId: "jjjj0000",
    });
  });

  it("returns null for tracks, albums, playlists, junk and empty text", () => {
    expect(parseSpotifyArtistLink(LINK_A)).toBeNull();
    expect(parseSpotifyArtistLink(ALBUM_URL)).toBeNull();
    expect(parseSpotifyArtistLink(PLAYLIST_URL)).toBeNull();
    expect(parseSpotifyArtistLink("spotify:track:aaaa1111")).toBeNull();
    expect(parseSpotifyArtistLink("https://example.com/artist/xxxx")).toBeNull();
    expect(parseSpotifyArtistLink("")).toBeNull();
  });

  it("rejects an artist URI with trailing junk", () => {
    expect(parseSpotifyArtistLink("spotify:artist:ffff6666:extra")).toBeNull();
  });
});

describe("parseSpotifyLinks", () => {
  it("splits a mixed paste into tracks and playlists", () => {
    const text = `${LINK_A}\n${PLAYLIST_URL}\nspotify:playlist:qqqq2222 ${LINK_B}`;
    const links = parseSpotifyLinks(text);
    expect(links.tracks.map((t) => t.trackId)).toEqual(["aaaa1111", "bbbb2222"]);
    expect(links.playlists.map((p) => p.playlistId)).toEqual(["pppp1111", "qqqq2222"]);
  });

  it("splits albums and artists out of a mixed paste", () => {
    const text = `${ALBUM_URL}\n${ARTIST_URL} spotify:album:kkkk1111`;
    const links = parseSpotifyLinks(text);
    expect(links.albums.map((a) => a.albumId)).toEqual(["eeee5555", "kkkk1111"]);
    expect(links.artists.map((a) => a.artistId)).toEqual(["ffff6666"]);
  });

  it("dedupes playlists by id across url and uri forms", () => {
    const text = `${PLAYLIST_URL}?si=one spotify:playlist:pppp1111 ${PLAYLIST_URL}`;
    expect(parseSpotifyLinks(text).playlists.map((p) => p.playlistId)).toEqual(["pppp1111"]);
  });

  it("dedupes albums and artists by id across url and uri forms", () => {
    const text = `${ALBUM_URL}?si=one spotify:album:eeee5555 ${ARTIST_URL} spotify:artist:ffff6666`;
    const links = parseSpotifyLinks(text);
    expect(links.albums.map((a) => a.albumId)).toEqual(["eeee5555"]);
    expect(links.artists.map((a) => a.artistId)).toEqual(["ffff6666"]);
  });

  it("dedupes each kind independently — the same id string can name both a track and an album", () => {
    const text = "https://open.spotify.com/track/sameid1 https://open.spotify.com/album/sameid1";
    const links = parseSpotifyLinks(text);
    expect(links.tracks.map((t) => t.trackId)).toEqual(["sameid1"]);
    expect(links.albums.map((a) => a.albumId)).toEqual(["sameid1"]);
  });

  it("returns four empty lists for junk", () => {
    expect(parseSpotifyLinks("nothing to see here")).toEqual({
      tracks: [],
      playlists: [],
      albums: [],
      artists: [],
    });
  });
});
