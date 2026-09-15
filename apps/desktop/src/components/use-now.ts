import { useEffect, useState } from "react";

/**
 * The current time, re-read every `intervalMs`.
 *
 * For views that show an elapsed duration: the value they derive from goes
 * stale on its own, and nothing else tells React to look again.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);

  return now;
}
