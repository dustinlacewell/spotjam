import { ButtonLink } from "@spotjam/ui";
import styles from "./Footer.module.css";

export function Footer({ releasesUrl }: { releasesUrl: string }) {
  return (
    <footer className={styles.footer}>
      <ButtonLink variant="primary" size="lg" href={releasesUrl}>
        Download spotjam
      </ButtonLink>
      <p className={styles.fine}>Free and open source.</p>
    </footer>
  );
}
