import type { ActionState } from "../actions";

export function FormStatus({ state }: { state: ActionState }) {
  if (state.error) return <p className="form-status error" role="alert">{state.error}</p>;
  if (state.message) return <p className="form-status ok" role="status">{state.message}</p>;
  return null;
}
