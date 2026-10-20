import { describe, expect, it } from "vitest";
import { parseVariantList } from "../admin/validation";
import { lineIsNew, stockChangesSince, withStockChanges, type OrderedItem } from "./import-record";

const at = (iso: string) => new Date(iso);

describe("lineIsNew", () => {
  const record = { sku: "K12", lineAt: "2026-10-06T09:16:00.000Z", photos: [] };

  it("applies only a line sent after the one imported last, whatever the shop did since", () => {
    expect(lineIsNew(at("2026-10-06T09:16:00Z"), record, at("2026-10-07T00:00:00Z"))).toBe(false);
    expect(lineIsNew(at("2026-10-06T12:40:00Z"), record, at("2026-10-07T00:00:00Z"))).toBe(true);
  });

  it("for a product made in the admin, applies only a line sent after its last edit", () => {
    expect(lineIsNew(at("2026-09-28T09:15:00Z"), null, at("2026-09-29T22:57:22Z"))).toBe(false);
    expect(lineIsNew(at("2026-10-06T08:50:00Z"), null, at("2026-09-29T22:57:22Z"))).toBe(true);
    expect(lineIsNew(at("2026-10-06T08:50:00Z"), { ...record, lineAt: null }, at("2026-09-29T22:57:22Z"))).toBe(true);
  });

  it("never applies a line whose date can't be read", () => {
    expect(lineIsNew(null, null, at("2020-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("stockChangesSince", () => {
  const since = at("2026-10-06T10:00:00Z");
  const item = (size: string, quantity: number, status: string, confirmedAt: string | null, cancelledAt: string | null = null): OrderedItem => ({
    normalizedSize: size,
    quantity,
    status,
    confirmedAt,
    cancelledAt,
  });

  it("takes off what orders confirmed after the line took, and adds back what was returned after it", () => {
    const changes = stockChangesSince(
      [
        item("M", 1, "confirmed", "2026-10-06T11:00:00Z"), // sold after the line
        item("M", 2, "delivered", "2026-10-06T12:00:00Z"), // sold and delivered after it
        item("L", 1, "cancelled", "2026-10-06T11:00:00Z", "2026-10-06T13:00:00Z"), // sold and returned after it: no change
        item("S", 1, "cancelled", "2026-10-06T09:00:00Z", "2026-10-06T12:00:00Z"), // sold before, returned after: back in stock
        item("S", 3, "shipped", "2026-10-06T09:00:00Z"), // sold before the line: already counted
        item("XL", 1, "placed", null), // not confirmed yet: took nothing
      ],
      since,
    );
    expect([...changes]).toEqual([
      ["M", -3],
      ["S", 1],
    ]);
  });

  it("applies the changes to the line's counts, never below zero", () => {
    const parsed = parseVariantList([
      { sizeLabel: "S", stockQty: "2", variantSku: "" },
      { sizeLabel: "M", stockQty: "2", variantSku: "" },
      { sizeLabel: "L", stockQty: "1", variantSku: "" },
    ]);
    if (!parsed.ok) throw new Error(parsed.error);
    const result = withStockChanges(
      parsed.variants,
      new Map([
        ["M", -3],
        ["S", 1],
      ]),
    );
    expect(result.variants.map((variant) => `${variant.sizeLabel}${variant.stockQty}`)).toEqual(["S3", "M0", "L1"]);
    expect(result.changed).toEqual(["S 2→3", "M 2→0"]);
  });
});
