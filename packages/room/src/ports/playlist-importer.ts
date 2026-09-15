// The playlist importer port — how the app layer pulls a playlist in from
// outside. The desktop app fetches it through Rust; the shape it returns is
// the only thing the app layer knows about.

import type { ParsedTrack } from "../lib/spotify-link";

/** A playlist as it arrives from outside: a name and the tracks we can queue. */
export interface ImportedPlaylist {
  name: string;
  tracks: ParsedTrack[];
}

export interface PlaylistImporter {
  import(uri: string): Promise<ImportedPlaylist>;
}
