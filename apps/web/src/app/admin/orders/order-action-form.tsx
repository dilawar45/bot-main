"use client";

import { useActionState, useId } from "react";
import type { ActionState } from "../products/actions";
import { FormStatus } from "../products/_components/form-status";

// One order step (confirm, ship, deliver, cancel): an optional detail, "tell the customer" and a button.
export function OrderActionForm({
  action,
  label,
  pendingLabel,
  variant = "primary",
  extraLabel,
  extraPlaceholder,
  confirmText,
  notifyByDefault = true,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
  // e.g. tracking number or cancellation reason
  extraLabel?: string;
  extraPlaceholder?: string;
  confirmText?: string;
  notifyByDefault?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = useId();
  return (
    <form
      action={formAction}
      className="order-action"
      onSubmit={(event) => {
        if (confirmText && !window.confirm(confirmText)) event.preventDefault();
      }}
    >
      {extraLabel ? (
        <label htmlFor={`${id}-extra`} className="order-action-extra">
          {extraLabel}
          <input id={`${id}-extra`} name="extra" maxLength={200} placeholder={extraPlaceholder} />
        </label>
      ) : null}
      <label className="check">
        <input type="checkbox" name="notify" defaultChecked={notifyByDefault} /> Tell the customer on WhatsApp
      </label>
      <div className="form-footer">
        <button type="submit" className={variant === "primary" ? undefined : variant} disabled={pending}>
          {pending ? pendingLabel : label}
        </button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
