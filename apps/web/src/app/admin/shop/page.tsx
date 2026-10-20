import { requireAdmin } from "@/auth/admin";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { loadShopSettings } from "@/shop/settings-store";
import { saveShopSettingsAction } from "./actions";
import { ShopForm } from "./shop-form";

export default async function ShopPage() {
  await requireAdmin();
  // No silent defaults here: saving an empty form over a temporarily unreadable file would erase it.
  const settings = await loadShopSettings(createSupabaseServiceClient()).catch(() => null);

  return (
    <main className="admin-main">
      <h1>Shop info</h1>
      <p className="muted">What the WhatsApp assistant knows about your shop, and how it should talk. Prices and stock always come from Products.</p>
      {settings ? (
        <ShopForm key={JSON.stringify(settings).length} settings={settings} action={saveShopSettingsAction} />
      ) : (
        <p className="form-status error" role="alert">Couldn&apos;t load the saved shop info right now. Refresh in a moment; nothing was changed.</p>
      )}
    </main>
  );
}
