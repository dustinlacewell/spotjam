import { Mark, ButtonLink } from "@spotjam/ui";
import { RELEASES_URL, REPO_URL } from "../links";
import styles from "./Hero.module.css";

export function Hero() {
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
        <ButtonLink variant="primary" size="lg" href={RELEASES_URL}>
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
