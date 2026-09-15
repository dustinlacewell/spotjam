import { Hero } from "./components/Hero";
import { RoomPreview } from "./components/RoomPreview";
import { Features } from "./components/Features";
import { Downloads } from "./components/Downloads";
import { Footer } from "./components/Footer";
import { useLatestRelease } from "./use-latest-version";
import { RELEASES_URL } from "./links";
import styles from "./App.module.css";

export function App() {
  // One fetch for the page: the download list and the version in the footer
  // are the same answer.
  const latest = useLatestRelease();
  const version = latest.state === "known" ? latest.version : null;

  return (
    <div className={styles.page}>
      <Hero />
      <RoomPreview />
      <Features />
      {latest.state === "known" && version !== null ? (
        <Downloads version={version} downloads={latest.downloads} />
      ) : null}
      <Footer releasesUrl={RELEASES_URL} version={version} />
    </div>
  );
}
