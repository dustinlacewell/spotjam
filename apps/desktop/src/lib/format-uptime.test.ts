import { describe, expect, it } from "vitest";
import { formatUptime } from "./format-uptime";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ago = (ms: number) => formatUptime(NOW - ms, NOW);

describe("formatUptime", () => {
  it("says <1m for anything under a minute", () => {
    expect(ago(0)).toBe("<1m");
    expect(ago(59_999)).toBe("<1m");
  });

  it("counts whole minutes up to an hour", () => {
    expect(ago(MINUTE)).toBe("1m");
    expect(ago(12 * MINUTE)).toBe("12m");
    expect(ago(HOUR - 1)).toBe("59m");
  });

  it("counts whole hours up to a day", () => {
    expect(ago(HOUR)).toBe("1h");
    expect(ago(2 * HOUR + 40 * MINUTE)).toBe("2h");
    expect(ago(DAY - 1)).toBe("23h");
  });

  it("counts whole days beyond that", () => {
    expect(ago(DAY)).toBe("1d");
    expect(ago(3 * DAY + 5 * HOUR)).toBe("3d");
  });

  it("treats a future timestamp as brand new", () => {
    expect(ago(-5_000)).toBe("<1m");
  });
});
