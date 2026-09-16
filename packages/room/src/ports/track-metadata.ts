// The track metadata port — how the app layer turns a track URI into
// something it can draw. The desktop app resolves it through Rust; another
// shell could hit an HTTP endpoint or a fixture.

/** Display metadata for one track. */
export interface TrackInfo {
  title: string;
  artist: string;
  thumbnailUrl: string | null;
  /**
   * Track length in ms.
   *
   * Not a display field: it is what a queue item must carry for the server to
   * advance the pointer past it, and this lookup is where a link's length
   * comes from.
   */
  durationMs: number;
}

export interface TrackMetadataSource {
  /** Null when the track is unknown or the lookup failed. */
  resolve(trackUri: string): Promise<TrackInfo | null>;
}
