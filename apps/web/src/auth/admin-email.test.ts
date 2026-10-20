import { describe, expect, it } from "vitest";
import { isAllowedAdminEmail, safeAdminRedirect } from "./admin-email";

describe("isAllowedAdminEmail", () => {
  it("matches case-insensitively and trims", () => {
    expect(isAllowedAdminEmail(" Owner@Example.com ", "owner@example.com")).toBe(true);
  });

  it("rejects other emails and non-strings", () => {
    expect(isAllowedAdminEmail("intruder@example.com", "owner@example.com")).toBe(false);
    expect(isAllowedAdminEmail(undefined, "owner@example.com")).toBe(false);
  });
});

describe("safeAdminRedirect", () => {
  it("keeps admin paths", () => {
    expect(safeAdminRedirect("/admin/products?page=2")).toBe("/admin/products?page=2");
  });

  it("falls back for external or non-admin targets", () => {
    expect(safeAdminRedirect("https://evil.example")).toBe("/admin");
    expect(safeAdminRedirect("//evil.example/admin")).toBe("/admin");
    expect(safeAdminRedirect("/login")).toBe("/admin");
    expect(safeAdminRedirect("/admin\\..\\x")).toBe("/admin");
    expect(safeAdminRedirect(null)).toBe("/admin");
  });
});
