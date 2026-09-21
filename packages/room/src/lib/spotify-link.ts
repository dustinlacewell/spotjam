export interface ParsedTrack {
  uri: string;
  trackId: string;
}

export interface ParsedPlaylist {
  uri: string;
  playlistId: string;
}

export interface ParsedAlbum {
  uri: string;
  albumId: string;
}

export interface ParsedArtist {
  uri: string;
  artistId: string;
}

/** A block of pasted or dropped text, split into the link kinds we accept. */
export interface ParsedLinks {
  tracks: ParsedTrack[];
  playlists: ParsedPlaylist[];
  albums: ParsedAlbum[];
  artists: ParsedArtist[];
}

const SHARE_URL_PATTERN =
  /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)/;
const URI_PATTERN = /^spotify:track:([a-zA-Z0-9]+)$/;

const PLAYLIST_URL_PATTERN =
  /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?playlist\/([a-zA-Z0-9]+)/;
const PLAYLIST_URI_PATTERN = /^spotify:playlist:([a-zA-Z0-9]+)$/;

const ALBUM_URL_PATTERN =
  /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?album\/([a-zA-Z0-9]+)/;
const ALBUM_URI_PATTERN = /^spotify:album:([a-zA-Z0-9]+)$/;

const ARTIST_URL_PATTERN =
  /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?artist\/([a-zA-Z0-9]+)/;
const ARTIST_URI_PATTERN = /^spotify:artist:([a-zA-Z0-9]+)$/;

/**
 * Parses a pasted Spotify share link (https://open.spotify.com/track/...)
 * or a raw spotify:track:... URI into a canonical track reference.
 * Returns null if the input isn't a recognizable track link.
 */
export function parseSpotifyTrackLink(input: string): ParsedTrack | null {
  const trimmed = input.trim();

  const uriMatch = trimmed.match(URI_PATTERN);
  if (uriMatch) {
    return { uri: trimmed, trackId: uriMatch[1] };
  }

  const urlMatch = trimmed.match(SHARE_URL_PATTERN);
  if (urlMatch) {
    const trackId = urlMatch[1];
    return { uri: `spotify:track:${trackId}`, trackId };
  }

  return null;
}

/**
 * Parses every Spotify track link in a block of text — a multi-line paste or a
 * drag payload carrying several URLs. Unrecognisable words are dropped and
 * repeated tracks appear once, in the order they were first seen.
 */
export function parseSpotifyTrackLinks(text: string): ParsedTrack[] {
  return parseSpotifyLinks(text).tracks;
}

/**
 * Parses a Spotify playlist share link (https://open.spotify.com/playlist/...)
 * or a raw spotify:playlist:... URI. Returns null for anything else, including
 * track links.
 */
export function parseSpotifyPlaylistLink(input: string): ParsedPlaylist | null {
  const trimmed = input.trim();

  const uriMatch = trimmed.match(PLAYLIST_URI_PATTERN);
  if (uriMatch) {
    return { uri: trimmed, playlistId: uriMatch[1] };
  }

  const urlMatch = trimmed.match(PLAYLIST_URL_PATTERN);
  if (urlMatch) {
    const playlistId = urlMatch[1];
    return { uri: `spotify:playlist:${playlistId}`, playlistId };
  }

  return null;
}

/**
 * Parses a Spotify album share link (https://open.spotify.com/album/...)
 * or a raw spotify:album:... URI. Returns null for anything else, including
 * track, artist and playlist links.
 */
export function parseSpotifyAlbumLink(input: string): ParsedAlbum | null {
  const trimmed = input.trim();

  const uriMatch = trimmed.match(ALBUM_URI_PATTERN);
  if (uriMatch) {
    return { uri: trimmed, albumId: uriMatch[1] };
  }

  const urlMatch = trimmed.match(ALBUM_URL_PATTERN);
  if (urlMatch) {
    const albumId = urlMatch[1];
    return { uri: `spotify:album:${albumId}`, albumId };
  }

  return null;
}

/**
 * Parses a Spotify artist share link (https://open.spotify.com/artist/...)
 * or a raw spotify:artist:... URI. Returns null for anything else, including
 * track, album and playlist links.
 */
export function parseSpotifyArtistLink(input: string): ParsedArtist | null {
  const trimmed = input.trim();

  const uriMatch = trimmed.match(ARTIST_URI_PATTERN);
  if (uriMatch) {
    return { uri: trimmed, artistId: uriMatch[1] };
  }

  const urlMatch = trimmed.match(ARTIST_URL_PATTERN);
  if (urlMatch) {
    const artistId = urlMatch[1];
    return { uri: `spotify:artist:${artistId}`, artistId };
  }

  return null;
}

/**
 * Splits a block of text — a multi-line paste or a drag payload — into the
 * tracks, playlists, albums and artists it mentions. Unrecognisable words are
 * dropped and each id appears once, in the order it was first seen.
 */
export function parseSpotifyLinks(text: string): ParsedLinks {
  // Track, playlist, album and artist ids are independently namespaced — the
  // same base62 string can be both a track id and an album id — so the
  // dedupe key carries the kind.
  const seen = new Set<string>();
  const tracks: ParsedTrack[] = [];
  const playlists: ParsedPlaylist[] = [];
  const albums: ParsedAlbum[] = [];
  const artists: ParsedArtist[] = [];

  const firstOf = <T extends object>(kind: string, id: string, parsed: T | null): T | null => {
    const key = `${kind}:${id}`;
    if (!parsed || seen.has(key)) return null;
    seen.add(key);
    return parsed;
  };

  for (const word of text.split(/\s+/)) {
    if (!word) continue;

    const track = parseSpotifyTrackLink(word);
    if (track && firstOf("track", track.trackId, track)) {
      tracks.push(track);
      continue;
    }

    const playlist = parseSpotifyPlaylistLink(word);
    if (playlist && firstOf("playlist", playlist.playlistId, playlist)) {
      playlists.push(playlist);
      continue;
    }

    const album = parseSpotifyAlbumLink(word);
    if (album && firstOf("album", album.albumId, album)) {
      albums.push(album);
      continue;
    }

    const artist = parseSpotifyArtistLink(word);
    if (artist && firstOf("artist", artist.artistId, artist)) {
      artists.push(artist);
    }
  }

  return { tracks, playlists, albums, artists };
}
