import { formatSize, groupDownloads, type Download } from "../lib/downloads";
import styles from "./Downloads.module.css";

/**
 * Every installer on the latest release, grouped by operating system.
 *
 * Nothing is guessed from the browser: the release names its own architectures,
 * so a visitor picks rather than being picked for.
 */
export function Downloads({ version, downloads }: { version: string; downloads: Download[] }) {
  const groups = groupDownloads(downloads);
  if (groups.length === 0) return null;

  return (
    <section id="download" className={styles.section}>
      <h2 className={styles.heading}>
        Download <span className={styles.version}>v{version}</span>
      </h2>

      <div className={styles.groups}>
        {groups.map((group) => (
          <div key={group.os} className={styles.group}>
            <h3 className={styles.os}>{group.title}</h3>
            <ul className={styles.list}>
              {group.items.map((item) => (
                <li key={item.name}>
                  <a className={styles.link} href={item.url}>
                    <span className={styles.label}>{item.label}</span>
                    <span className={styles.size}>{formatSize(item.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
