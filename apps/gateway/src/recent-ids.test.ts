import { describe, expect, it } from "vitest";
import { RecentIds } from "./recent-ids.js";

describe("RecentIds", () => {
  it("reports whether an id is new", () => {
    const ids = new RecentIds(10);
    expect(ids.add("a")).toBe(true);
    expect(ids.add("a")).toBe(false);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(false);
  });

  it("forgets the oldest ids beyond its limit", () => {
    const ids = new RecentIds(2);
    ids.add("a");
    ids.add("b");
    ids.add("a");
    ids.add("c");
    expect([ids.has("a"), ids.has("b"), ids.has("c")]).toEqual([false, true, true]);
  });
});
