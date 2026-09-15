// The track metadata port — how the app layer turns a track URI into
// something it can draw. The desktop app resolves it through Rust; another
// shell could hit an HTTP endpoint or a fixture.

/** Display metadata for one track. */
export interface TrackInfo {
  title: string;
  artist: string;
  thumbnailUrl: string | null;
}

export interface TrackMetadataSource {
  /** Null when the track is unknown or the lookup failed. */
  resolve(trackUri: string): Promise<TrackInfo | null>;
}
