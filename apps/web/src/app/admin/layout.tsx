import { LogOut } from "lucide-react";
import { NavLink } from "./_components/nav-link";
import { requireAdmin } from "@/auth/admin";
import { countNeedingHuman } from "@/conversations/admin-queries";
import { countNewOrders } from "@/orders/admin-queries";
import { signOut } from "../login/actions";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const admin = await requireAdmin();
  const [waiting, newOrders] = await Promise.all([countNeedingHuman().catch(() => 0), countNewOrders().catch(() => 0)]);

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <nav className="admin-nav" aria-label="Admin">
          <strong>Huzaifa Commerce Desk</strong>
          <NavLink href="/admin">Today</NavLink>
          <NavLink href="/admin/products">Products</NavLink>
          <NavLink href="/admin/conversations">
            Conversations
            {waiting ? <span className="nav-count" aria-label={`${waiting} waiting for a person`}>{waiting}</span> : null}
          </NavLink>
          <NavLink href="/admin/orders">
            Orders
            {newOrders ? <span className="nav-count" aria-label={`${newOrders} new orders to confirm`}>{newOrders}</span> : null}
          </NavLink>
          <NavLink href="/admin/shop">Shop info</NavLink>
          <NavLink href="/admin/whatsapp">WhatsApp</NavLink>
        </nav>
        <div className="admin-user">
          <span>{admin.email}</span>
          <form action={signOut}>
            <button type="submit" aria-label="Sign out"><LogOut size={16} /> Sign out</button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
