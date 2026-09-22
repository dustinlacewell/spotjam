// Test-only surface for src/lib. Kept out of the app bundle: only test files
// import it.

/** Decode a hex string into bytes, for building hand-made envelopes. */
export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}