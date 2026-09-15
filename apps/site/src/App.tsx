import { Hero } from "./components/Hero";
import { RoomPreview } from "./components/RoomPreview";
import { Features } from "./components/Features";
import { Footer } from "./components/Footer";
import { RELEASES_URL } from "./links";
import styles from "./App.module.css";

export function App() {
  return (
    <div className={styles.page}>
      <Hero />
      <RoomPreview />
      <Features />
      <Footer releasesUrl={RELEASES_URL} />
    </div>
  );
}
