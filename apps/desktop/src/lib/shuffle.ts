/**
 * Fisher-Yates, on a copy. The caller passes its own randomness so tests can
 * pin an order; production passes Math.random.
 */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}
