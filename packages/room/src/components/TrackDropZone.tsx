import { useRef, useState } from "react";
import type { ParsedLinks } from "../lib/spotify-link";
import { INTERNAL_DRAG_MIME, linksFromDrop } from "../lib/drop-links";
import styles from "./TrackDropZone.module.css";

/**
 * Accepts Spotify tracks and playlists dragged in from outside the app (the
 * desktop client carries share URLs in text/uri-list and text/plain). In-app
 * reorder drags carry INTERNAL_DRAG_MIME and pass straight through.
 */
export function TrackDropZone({
  onLinks,
  children,
}: {
  onLinks: (links: ParsedLinks) => void;
  children: React.ReactNode;
}) {
  const [isOver, setIsOver] = useState(false);
  // dragenter/dragleave fire for every descendant; count them to know when we left.
  const depth = useRef(0);

  function reset() {
    depth.current = 0;
    setIsOver(false);
  }

  return (
    <div
      className={isOver ? styles.zoneOver : styles.zone}
      onDragEnter={(e) => {
        if (!carriesTracks(e.dataTransfer)) return;
        depth.current += 1;
        setIsOver(true);
      }}
      onDragOver={(e) => {
        if (!carriesTracks(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setIsOver(true);
      }}
      onDragLeave={(e) => {
        if (!carriesTracks(e.dataTransfer)) return;
        depth.current -= 1;
        if (depth.current <= 0) reset();
      }}
      onDrop={(e) => {
        if (!carriesTracks(e.dataTransfer)) return;
        e.preventDefault();
        reset();
        const links = linksFromDrop(e.dataTransfer);
        if (links.tracks.length > 0 || links.playlists.length > 0) onLinks(links);
      }}
    >
      {children}
    </div>
  );
}

function carriesTracks(data: DataTransfer): boolean {
  const types = Array.from(data.types);
  if (types.includes(INTERNAL_DRAG_MIME)) return false;
  return types.includes("text/uri-list") || types.includes("text/plain");
}
