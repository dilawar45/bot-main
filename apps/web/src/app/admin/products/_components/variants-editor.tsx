"use client";

import { Plus, X } from "lucide-react";
import { useActionState, useState } from "react";
import type { ActionState } from "../actions";
import { FormStatus } from "./form-status";

// loadedSize/loadedStock: the size as it was when the page loaded ("" for new rows). The server applies the
// difference to the current stock, so an order confirmed or cancelled meanwhile isn't overwritten.
type Row = { key: number; sizeLabel: string; stockQty: string; variantSku: string; loadedSize: string; loadedStock: string };

export function VariantsEditor({
  action,
  variants,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  variants: { sizeLabel: string; stockQty: number; variantSku: string | null }[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [rows, setRows] = useState<Row[]>(() => {
    const initial = variants.map((variant, index) => ({
      key: index,
      sizeLabel: variant.sizeLabel,
      stockQty: String(variant.stockQty),
      variantSku: variant.variantSku ?? "",
      loadedSize: variant.sizeLabel,
      loadedStock: String(variant.stockQty),
    }));
    return initial.length ? initial : [{ key: 0, sizeLabel: "", stockQty: "0", variantSku: "", loadedSize: "", loadedStock: "" }];
  });

  const update = (key: number, field: "sizeLabel" | "stockQty" | "variantSku", value: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));

  return (
    <form action={formAction} className="admin-form">
      <div className="variant-table" role="table" aria-label="Sizes and stock">
        <div className="variant-row variant-head" role="row">
          <span role="columnheader">Size</span>
          <span role="columnheader">In stock</span>
          <span role="columnheader">Variant SKU (optional)</span>
          <span />
        </div>
        {rows.map((row) => (
          <div className="variant-row" role="row" key={row.key}>
            <input name="sizeLabel" aria-label="Size" value={row.sizeLabel} onChange={(event) => update(row.key, "sizeLabel", event.target.value)} placeholder="M" maxLength={30} />
            <input name="stockQty" aria-label="Stock quantity" value={row.stockQty} onChange={(event) => update(row.key, "stockQty", event.target.value)} inputMode="numeric" pattern="[0-9]*" />
            <input name="variantSku" aria-label="Variant SKU" value={row.variantSku} onChange={(event) => update(row.key, "variantSku", event.target.value)} maxLength={64} />
            <input type="hidden" name="loadedSize" value={row.loadedSize} />
            <input type="hidden" name="loadedStock" value={row.loadedStock} />
            <button type="button" className="icon-button" aria-label={`Remove size ${row.sizeLabel || "row"}`} onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
      <div className="form-footer">
        <button
          type="button"
          className="secondary"
          onClick={() =>
            setRows((current) => [...current, { key: Math.max(-1, ...current.map((row) => row.key)) + 1, sizeLabel: "", stockQty: "0", variantSku: "", loadedSize: "", loadedStock: "" }])
          }
        >
          <Plus size={16} /> Add size
        </button>
        <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save sizes"}</button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
