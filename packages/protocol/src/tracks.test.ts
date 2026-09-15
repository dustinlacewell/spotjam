import { describe, expect, it } from "vitest";
import { appendUniqueTracks, moveMany } from "./tracks.js";

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

function id(id: string): { id: string } {
  return { id };
}

const [w, x, y, z] = [id("w"), id("x"), id("y"), id("z")];

describe("moveMany", () => {
  it("moves the block before the named item, in the block's own relative order", () => {
    expect(moveMany([w, x, y, z], ["z", "x"], "w")).toEqual([x, z, w, y]);
  });

  it("moves the block to the end when beforeId is null", () => {
    expect(moveMany([w, x, y, z], ["w", "y"], null)).toEqual([x, z, w, y]);
  });

  it("moves the block to the end when beforeId names one of the moved items", () => {
    expect(moveMany([w, x, y, z], ["w", "y"], "y")).toEqual([x, z, w, y]);
  });

  it("moves the block to the end when beforeId is not found", () => {
    expect(moveMany([w, x, y], ["w"], "missing")).toEqual([x, y, w]);
  });

  it("returns the queue itself when movedIds is empty", () => {
    const queue = [w, x];
    expect(moveMany(queue, [], "x")).toBe(queue);
  });

  it("returns the queue itself when none of movedIds are present", () => {
    const queue = [w, x];
    expect(moveMany(queue, ["missing"], "x")).toBe(queue);
  });

  it("returns the queue itself when the block already sits where it's dropped", () => {
    const queue = [w, x, y, z];
    expect(moveMany(queue, ["x"], "y")).toBe(queue);
    expect(moveMany(queue, ["z"], null)).toBe(queue);
    expect(moveMany(queue, ["x", "y"], "z")).toBe(queue);
  });

  it("does not mutate its input", () => {
    const queue = [w, x, y];
    moveMany(queue, ["y"], "w");
    expect(queue).toEqual([w, x, y]);
  });
});
