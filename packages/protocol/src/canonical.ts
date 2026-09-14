// Canonical JSON — a deterministic byte encoding for signing.
//
// Two machines must derive identical bytes from identical data, or signatures
// will not verify. JSON.stringify is not enough: key order follows insertion
// order, so the same logical object can encode two ways. This module sorts
// keys at every depth and rejects values that have no stable encoding.

/** Values that may appear in a signed payload. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Serialize to a deterministic string: object keys sorted at every depth,
 * no insignificant whitespace.
 *
 * Throws on values with no stable encoding — undefined, functions, symbols,
 * NaN, Infinity, and non-integer-safe numbers. Rejecting loudly here beats a
 * signature that silently fails to verify on the other side.
 */
export function canonicalize(value: CanonicalValue): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(`canonicalize: non-finite number (${String(n)})`);
    }
    if (!Number.isSafeInteger(n) && !Number.isInteger(n)) {
      // Fractional numbers encode inconsistently across languages; spotjam
      // payloads only ever carry integers (epoch ms, offsets, indices).
      throw new TypeError(`canonicalize: non-integer number (${String(n)})`);
    }
    return JSON.stringify(n);
  }

  if (t === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (t === "object") {
    const obj = value as { [key: string]: CanonicalValue };
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) {
        throw new TypeError(`canonicalize: undefined value at key "${key}"`);
      }
      parts.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
    }
    return `{${parts.join(",")}}`;
  }

  throw new TypeError(`canonicalize: unsupported value of type ${t}`);
}

/** Canonical bytes, ready to sign or verify. */
export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
