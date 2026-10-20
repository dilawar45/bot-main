"use client";

import { useActionState } from "react";
import type { ActionState } from "../actions";
import { FormStatus } from "./form-status";

type ProductFormDefaults = {
  sku: string;
  name: string;
  description: string;
  category: string;
  color: string | null;
  material: string | null;
  styleTags: string[];
  aliases: string[];
  pricePkr: number | null;
};

const emptyProduct: ProductFormDefaults = {
  sku: "",
  name: "",
  description: "",
  category: "",
  color: null,
  material: null,
  styleTags: [],
  aliases: [],
  pricePkr: null,
};

export function ProductForm({
  action,
  defaults = emptyProduct,
  submitLabel,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  defaults?: ProductFormDefaults;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="admin-form">
      <div className="field-grid">
        <label>
          SKU
          <input name="sku" defaultValue={defaults.sku} required maxLength={64} autoCapitalize="characters" />
        </label>
        <label>
          Price (PKR)
          <input name="pricePkr" defaultValue={defaults.pricePkr ?? ""} required inputMode="numeric" pattern="[0-9,]*" placeholder="4500" />
        </label>
        <label className="span-2">
          Name
          <input name="name" defaultValue={defaults.name} required maxLength={160} />
        </label>
        <label>
          Category
          <input name="category" defaultValue={defaults.category} required maxLength={80} placeholder="suits" />
        </label>
        <label>
          Colour
          <input name="color" defaultValue={defaults.color ?? ""} maxLength={60} />
        </label>
        <label>
          Material
          <input name="material" defaultValue={defaults.material ?? ""} maxLength={80} />
        </label>
        <label>
          Style tags
          <input name="styleTags" defaultValue={defaults.styleTags.join(", ")} placeholder="printed, casual" />
        </label>
        <label className="span-2">
          Other names customers use
          <input name="aliases" defaultValue={defaults.aliases.join(", ")} placeholder="kurta, shalwar kameez" />
        </label>
        <label className="span-2">
          Description
          <textarea name="description" defaultValue={defaults.description} rows={4} maxLength={4000} />
        </label>
      </div>
      <div className="form-footer">
        <button type="submit" disabled={pending}>{pending ? "Saving…" : submitLabel}</button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
