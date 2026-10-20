"use client";

import { useActionState } from "react";
import type { ActionState } from "../products/actions";
import { FormStatus } from "../products/_components/form-status";

export function NoteForm({ action, note }: { action: (state: ActionState, formData: FormData) => Promise<ActionState>; note: string | null }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="admin-form">
      <label className="sr-only" htmlFor="internal-note">Internal note</label>
      <textarea id="internal-note" name="note" rows={3} maxLength={2000} defaultValue={note ?? ""} placeholder="Only you see this. E.g. wants delivery to Multan, call after 6pm." />
      <div className="form-footer">
        <button type="submit" className="secondary" disabled={pending}>{pending ? "Saving…" : "Save note"}</button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
