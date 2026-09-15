import { Mark, ButtonLink } from "@spotjam/ui";
import { REPO_URL } from "../links";
import styles from "./Hero.module.css";

/**
 * `downloadHref` points at the download section once there is one to jump to,
 * and at the releases page until then — a button that scrolls nowhere is worse
 * than one that leaves the page.
 */
export function Hero({ downloadHref }: { downloadHref: string }) {
  return (
    <header className={styles.hero}>
      <div className={styles.mark}>
        <Mark size="md" />
      </div>
      <h1 className={styles.headline}>Spotify jams, on the spot.</h1>
      <p className={styles.subhead}>
        Start a room, drop in tracks, jam together.
      </p>
      <div className={styles.actions}>
        <ButtonLink variant="primary" size="lg" href={downloadHref}>
          Download for free
        </ButtonLink>
        <ButtonLink variant="secondary" size="lg" href={REPO_URL}>
          View source
        </ButtonLink>
      </div>
      <p className={styles.platforms}>Windows · macOS · Linux</p>
    </header>
  );
}
