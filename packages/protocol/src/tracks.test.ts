import { describe, expect, it } from "vitest";
import { appendUniqueTracks } from "./tracks.js";

const a1 = { trackId: "a", tag: "first" };
const a2 = { trackId: "a", tag: "second" };
const b = { trackId: "b", tag: "b" };

describe("appendUniqueTracks", () => {
  it("appends tracks not yet held", () => {
    expect(appendUniqueTracks([a1], [b])).toEqual([a1, b]);
  });

  it("keeps the existing entry over an incoming one for the same track", () => {
    expect(appendUniqueTracks([a1], [a2])).toEqual([a1]);
  });

  it("lands a track listed twice in the batch once, at its first position", () => {
    expect(appendUniqueTracks([], [a1, b, a2])).toEqual([a1, b]);
  });

  it("returns the existing array itself when nothing new arrives", () => {
    const existing = [a1];
    expect(appendUniqueTracks(existing, [a2])).toBe(existing);
    expect(appendUniqueTracks(existing, [])).toBe(existing);
  });

  it("does not mutate its inputs", () => {
    const existing = [a1];
    const incoming = [b];
    appendUniqueTracks(existing, incoming);
    expect(existing).toEqual([a1]);
    expect(incoming).toEqual([b]);
  });
});
