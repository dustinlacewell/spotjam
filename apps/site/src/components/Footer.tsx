import { ButtonLink } from "@spotjam/ui";
import styles from "./Footer.module.css";

export function Footer({
  releasesUrl,
  version,
}: {
  releasesUrl: string;
  version: string | null;
}) {
  return (
    <footer className={styles.footer}>
      <ButtonLink variant="primary" size="lg" href={releasesUrl}>
        All releases
      </ButtonLink>
      <p className={styles.fine}>
        Free and open source.
        {version === null ? "" : ` v${version}`}
      </p>
    </footer>
  );
}
