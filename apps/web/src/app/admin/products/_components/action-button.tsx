"use client";

import { useActionState } from "react";
import type { ActionState } from "../actions";
import { FormStatus } from "./form-status";

export function ActionButton({
  action,
  label,
  pendingLabel,
  variant = "primary",
  confirmText,
  ariaLabel,
  children,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  label?: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "icon";
  confirmText?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form
      action={formAction}
      className="action-button"
      onSubmit={(event) => {
        if (confirmText && !window.confirm(confirmText)) event.preventDefault();
      }}
    >
      <button type="submit" className={variant === "primary" ? undefined : variant === "icon" ? "icon-button" : variant} disabled={pending} aria-label={ariaLabel}>
        {children}
        {label ? (pending ? pendingLabel ?? label : label) : null}
      </button>
      <FormStatus state={state} />
    </form>
  );
}
