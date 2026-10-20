"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-fetches the current server page on an interval so new WhatsApp messages show up without a manual reload.
// Skips while the tab is hidden, and refreshes right away when the owner comes back to it.
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refresh, intervalMs);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, intervalMs]);

  return null;
}
