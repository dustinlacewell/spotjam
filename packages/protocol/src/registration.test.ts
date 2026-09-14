import { describe, expect, it } from "vitest";
import {
  isValidUsername,
  normalizeUsername,
  USERNAME_MAX,
  USERNAME_MIN,
} from "./registration.js";

describe("isValidUsername", () => {
  it("accepts ordinary names", () => {
    for (const name of ["dustin", "aa", "a1", "with_underscore", "with-hyphen"]) {
      expect(isValidUsername(name)).toBe(true);
    }
  });

  it("enforces length bounds", () => {
    expect(isValidUsername("a".repeat(USERNAME_MIN - 1))).toBe(false);
    expect(isValidUsername("a".repeat(USERNAME_MIN))).toBe(true);
    expect(isValidUsername("a".repeat(USERNAME_MAX))).toBe(true);
    expect(isValidUsername("a".repeat(USERNAME_MAX + 1))).toBe(false);
  });

  it("requires a leading letter or digit", () => {
    expect(isValidUsername("_lead")).toBe(false);
    expect(isValidUsername("-lead")).toBe(false);
  });

  it("rejects spaces and punctuation", () => {
    for (const name of ["has space", "has.dot", "has@at", "emoji🎵"]) {
      expect(isValidUsername(name)).toBe(false);
    }
  });
});

describe("normalizeUsername", () => {
  it("folds case so collisions are caught", () => {
    expect(normalizeUsername("Dustin")).toBe("dustin");
    expect(normalizeUsername("DUSTIN")).toBe(normalizeUsername("dustin"));
  });
});
