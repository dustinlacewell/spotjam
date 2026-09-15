import type { ReactNode } from "react";
import styles from "./CenteredCardPage.module.css";

export interface CenteredCardPageProps {
  children: ReactNode;
}

export function CenteredCardPage({ children }: CenteredCardPageProps) {
  return (
    <div className={styles.page}>
      <div className={styles.card}>{children}</div>
    </div>
  );
}
