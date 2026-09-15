import { ButtonLink } from "@spotjam/ui";
import { useLatestVersion } from "../use-latest-version";
import styles from "./Footer.module.css";

export function Footer({ releasesUrl }: { releasesUrl: string }) {
  const latest = useLatestVersion();

  return (
    <footer className={styles.footer}>
      <ButtonLink variant="primary" size="lg" href={releasesUrl}>
        Download spotjam
      </ButtonLink>
      <p className={styles.fine}>
        Free and open source.
        {latest.state === "known" && latest.version !== null ? ` v${latest.version}` : ""}
      </p>
    </footer>
  );
}
