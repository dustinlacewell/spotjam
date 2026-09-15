import type { CSSProperties } from "react";
import styles from "./Thumbnail.module.css";

export interface ThumbnailProps {
  src?: string | null;
  size: number;
  radius?: "sm" | "md";
  alt?: string;
  fill?: string;
}

const radiusClass: Record<"sm" | "md", string> = {
  sm: styles.radiusSm,
  md: styles.radiusMd,
};

export function Thumbnail({
  src,
  size,
  radius = "sm",
  alt = "",
  fill,
}: ThumbnailProps) {
  const style: CSSProperties = { width: size, height: size };

  if (!src && fill) {
    style.background = fill;
  }

  return (
    <div className={`${styles.box} ${radiusClass[radius]}`} style={style}>
      {src ? <img className={styles.image} src={src} alt={alt} /> : null}
    </div>
  );
}
