import Link from "next/link";
import { CircleAlert, CircleCheck } from "lucide-react";
import { AutoRefresh } from "./_components/auto-refresh";
import { formatPrice } from "@/agent/compose";
import { requireAdmin } from "@/auth/admin";
import { loadOverview, type Overview } from "@/dashboard/queries";
import { karachiTime } from "@/shop/settings";

type Tile = { label: string; value: string; note?: string; href?: string; attention?: boolean };
type Check = { done: boolean; label: string; detail: string; href?: string; action?: string };

const shown = (value: number | null | undefined) => (value === null || value === undefined ? "—" : String(value));

function timeAgo(iso: string | undefined): string | null {
  if (!iso) return null;
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function tiles(overview: Overview): Tile[] {
  const { bot } = overview;
  return [
    { label: "Chats waiting for you", value: shown(overview.needsPerson), href: "/admin/conversations", attention: Boolean(overview.needsPerson) },
    { label: "New orders to confirm", value: shown(overview.newOrders), href: "/admin/orders", attention: Boolean(overview.newOrders) },
    { label: "Carts not confirmed yet", value: shown(overview.cartsAwaitingConfirm), note: "Saw the priced summary", href: "/admin/orders?tab=carts" },
    { label: "Customer messages today", value: shown(overview.messagesToday), href: "/admin/conversations?view=all" },
    {
      label: "Orders today",
      value: shown(overview.ordersToday?.count),
      note: overview.ordersToday?.count ? formatPrice(overview.ordersToday.totalPkr) : undefined,
      href: "/admin/orders?tab=confirmed",
    },
    {
      label: "Bot replies, last 24 h",
      value: shown(bot?.replies),
      note: bot?.replies
        ? `${Math.round((bot.byAi / bot.replies) * 100)}% written by AI${bot.medianMs ? ` · usually ${(bot.medianMs / 1_000).toFixed(1)} s` : ""}`
        : undefined,
      attention: Boolean(bot && bot.replies >= 5 && bot.rules / bot.replies > 0.3),
    },
  ];
}

// What still stands between the shop and good WhatsApp sales, most important first.
function checklist(overview: Overview): Check[] {
  const { catalog, shop, meaningSearch, photoSearch, whatsapp } = overview;
  const checks: Check[] = [];
  checks.push(
    whatsapp?.state === "ready"
      ? { done: true, label: "WhatsApp connected", detail: `${whatsapp.phoneNumber ? `+${whatsapp.phoneNumber}` : "Linked"}${whatsapp.updatedAt ? ` · status checked ${timeAgo(whatsapp.updatedAt)}` : ""}` }
      : { done: false, label: "WhatsApp not connected", detail: overview.whatsappProblem ?? `Now: ${whatsapp?.state ?? "unknown"}. Customers get no replies.`, href: "/admin/whatsapp", action: "Open WhatsApp" },
  );
  if (catalog) {
    checks.push({
      done: catalog.active >= 5,
      label: `${catalog.active} product${catalog.active === 1 ? "" : "s"} for sale`,
      detail: catalog.active >= 5 ? "Customers can browse a real choice." : "With this few items the bot keeps offering the same thing. Add your stock and publish it.",
      href: "/admin/products/new",
      action: "Add product",
    });
    if (catalog.drafts) checks.push({ done: false, label: `${catalog.drafts} draft${catalog.drafts === 1 ? "" : "s"} not published`, detail: "Drafts are invisible to customers until you publish them.", href: "/admin/products", action: "Review drafts" });
    if (catalog.active) {
      checks.push({
        done: catalog.withoutPhoto === 0,
        label: catalog.withoutPhoto ? `${catalog.withoutPhoto} product${catalog.withoutPhoto === 1 ? "" : "s"} without a photo` : "Every product has a photo",
        detail: catalog.withoutPhoto ? "Products without a photo are sent as plain text, and can't be found from a customer's photo." : "Cards go out with photos.",
        href: "/admin/products",
        action: "Add photos",
      });
      if (catalog.soldOut) checks.push({ done: false, label: `${catalog.soldOut} product${catalog.soldOut === 1 ? "" : "s"} sold out in every size`, detail: "Update stock or archive them so the bot doesn't keep apologising.", href: "/admin/products", action: "Update stock" });
    }
  }
  if (shop) {
    const missing = [!shop.delivery && "delivery", !shop.payment && "payment", !shop.returns && "returns"].filter(Boolean);
    checks.push({
      done: missing.length === 0,
      label: missing.length ? `Shop info missing: ${missing.join(", ")}` : "Delivery, payment and returns filled in",
      detail: missing.length ? "Until then the bot says a team member will confirm, and buyers wait for you." : "The bot answers these itself.",
      href: "/admin/shop",
      action: "Shop info",
    });
    if (shop.ordersEnabled) {
      checks.push({
        done: shop.deliveryFeePkr !== null,
        label: shop.deliveryFeePkr !== null ? `Delivery charge ${formatPrice(shop.deliveryFeePkr)}` : "No delivery charge set",
        detail: shop.deliveryFeePkr !== null ? "Order summaries show a full total." : "Order summaries say “team will confirm the charge” instead of a total.",
        href: "/admin/shop",
        action: "Set charge",
      });
    }
    const exampleLines = shop.exampleChats.split("\n").filter((line) => line.trim()).length;
    checks.push({
      done: exampleLines >= 20,
      label: exampleLines ? `${exampleLines} lines of example chats` : "No example chats yet",
      detail: "20–30 real exchanges are the fastest way for the bot to sound like you.",
      href: "/admin/shop",
      action: "Add examples",
    });
  }
  if (overview.ordersMigration === false) checks.push({ done: false, label: "Order taking is off", detail: "Apply 202609290003_orders.sql in the Supabase SQL Editor." });
  if (overview.followUpsMigration === false) checks.push({ done: false, label: "Order reminders are off", detail: "Apply 202610060001_order_followups.sql in the Supabase SQL Editor." });
  if (meaningSearch) {
    checks.push(
      !meaningSearch.available
        ? { done: false, label: "Meaning search is off", detail: "Apply 202609290004_product_embeddings.sql in the Supabase SQL Editor." }
        : { done: meaningSearch.indexed >= meaningSearch.total, label: `Meaning search: ${meaningSearch.indexed} of ${meaningSearch.total} products indexed`, detail: "Finds items by other names (chadar, burqa…).", href: "/admin/products", action: "Update index" },
    );
  }
  if (photoSearch) {
    checks.push(
      !photoSearch.available
        ? { done: false, label: "Photo search is off", detail: "Apply 202610060002_product_image_embeddings.sql in the Supabase SQL Editor." }
        : { done: photoSearch.indexed >= photoSearch.total, label: `Photo search: ${photoSearch.indexed} of ${photoSearch.total} photos indexed`, detail: "Finds the product in a customer's screenshot or photo.", href: "/admin/products", action: "Update index" },
    );
  }
  return checks;
}

export default async function AdminHome() {
  await requireAdmin();
  const overview = await loadOverview();
  const checks = checklist(overview);
  const todo = checks.filter((check) => !check.done).length;
  const now = karachiTime(new Date());

  return (
    <main className="admin-main">
      <AutoRefresh intervalMs={30_000} />
      <div className="page-head">
        <h1>Today</h1>
        <span className="muted small">Pakistan time {now.label.slice(4)} · updates every 30 seconds</span>
      </div>

      <section className="stat-grid" aria-label="At a glance">
        {tiles(overview).map((tile) => {
          const body = (
            <>
              <span className="stat-label">{tile.label}</span>
              <strong className="stat-value">{tile.value}</strong>
              {tile.note ? <span className="stat-note">{tile.note}</span> : null}
            </>
          );
          const className = `stat-tile${tile.attention ? " attention" : ""}`;
          return tile.href ? (
            <Link key={tile.label} href={tile.href} className={className}>
              {body}
            </Link>
          ) : (
            <div key={tile.label} className={className}>
              {body}
            </div>
          );
        })}
      </section>
      {overview.bot && overview.bot.replies >= 5 && overview.bot.rules / overview.bot.replies > 0.3 ? (
        <p className="muted small">
          Many replies came from the keyword rules instead of the AI: Gemini keys may be out of quota or its models overloaded. See the runbook, “AI errors”.
        </p>
      ) : null}

      <section className="panel">
        <div className="page-head">
          <h2>Ready to sell</h2>
          <span className="muted small">{todo ? `${todo} to do` : "All set"}</span>
        </div>
        <ul className="checklist">
          {checks.map((check) => (
            <li key={check.label} className={check.done ? "done" : "todo"}>
              {check.done ? <CircleCheck size={18} aria-hidden /> : <CircleAlert size={18} aria-hidden />}
              <span>
                <strong>
                  <span className="sr-only">{check.done ? "Done: " : "To do: "}</span>
                  {check.label}
                </strong>
                <span className="muted small">{check.detail}</span>
              </span>
              {check.href && !check.done ? (
                <Link href={check.href} className="button-link secondary-link">
                  {check.action ?? "Open"}
                </Link>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
