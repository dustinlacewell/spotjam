export interface ParsedTrack {
  uri: string;
  trackId: string;
}

export interface ParsedPlaylist {
  uri: string;
  playlistId: string;
}

/** A block of pasted or dropped text, split into the two link kinds we accept. */
export interface ParsedLinks {
  tracks: ParsedTrack[];
  playlists: ParsedPlaylist[];
}

const SHARE_URL_PATTERN =
  /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)/;
const URI_PATTERN = /^spotify:track:([a-zA-Z0-9]+)$/;

const PLAYLIST_URL_PATTERN =
  /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?playlist\/([a-zA-Z0-9]+)/;
const PLAYLIST_URI_PATTERN = /^spotify:playlist:([a-zA-Z0-9]+)$/;

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
 * Splits a block of text — a multi-line paste or a drag payload — into the
 * tracks and the playlists it mentions. Unrecognisable words are dropped and
 * each id appears once, in the order it was first seen.
 */
export function parseSpotifyLinks(text: string): ParsedLinks {
  const seenTracks = new Set<string>();
  const seenPlaylists = new Set<string>();
  const tracks: ParsedTrack[] = [];
  const playlists: ParsedPlaylist[] = [];

  for (const word of text.split(/\s+/)) {
    if (!word) continue;

    const track = parseSpotifyTrackLink(word);
    if (track) {
      if (!seenTracks.has(track.trackId)) {
        seenTracks.add(track.trackId);
        tracks.push(track);
      }
      continue;
    }

    const playlist = parseSpotifyPlaylistLink(word);
    if (playlist && !seenPlaylists.has(playlist.playlistId)) {
      seenPlaylists.add(playlist.playlistId);
      playlists.push(playlist);
    }
  }

  return { tracks, playlists };
}
