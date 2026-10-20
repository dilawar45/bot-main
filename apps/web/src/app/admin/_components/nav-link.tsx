"use client";

import Link, { useLinkStatus } from "next/link";
import type { ComponentProps } from "react";

function PendingHint() {
  const { pending } = useLinkStatus();
  return pending ? <span className="spinner spinner-inline" role="status" aria-label="Loading" /> : null;
}

// A Link that shows a small spinner from the moment it's clicked until the new page is ready.
export function NavLink({ children, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link {...props}>
      {children}
      <PendingHint />
    </Link>
  );
}
