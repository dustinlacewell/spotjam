import { Card } from "@spotjam/ui";
import styles from "./Features.module.css";

const FEATURES = [
  {
    title: "Shared queue",
    body: "Everyone in the room adds tracks to one queue. No back-and-forth over whose playlist plays next.",
  },
  {
    title: "Live rooms",
    body: "Browse rooms that are open right now, see who's in them and what's playing, and join with one click.",
  },
  {
    title: "Broadcast sync",
    body: "One person broadcasts and the room follows along, so everyone hears the same track at the same moment.",
  },
];

export function Features() {
  return (
    <section className={styles.section}>
      <div className={styles.grid}>
        {FEATURES.map((feature) => (
          <Card key={feature.title} padding="lg" interactive>
            <h3 className={styles.title}>{feature.title}</h3>
            <p className={styles.body}>{feature.body}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
