import { ImageOff, Plus, Sparkles } from "lucide-react";
import Form from "next/form";
import { NavLink } from "../_components/nav-link";
import { ActionButton } from "./_components/action-button";
import { rebuildSearchIndex } from "./actions";
import { requireAdmin } from "@/auth/admin";
import { PRODUCT_STATUSES, listAdminProducts, type ProductStatus } from "@/catalog/admin/queries";
import { searchIndexStatus } from "@/catalog/embeddings";
import { photoIndexStatus } from "@/catalog/image-embeddings";
import { getVisionEnvironment } from "@/config/env";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const status = PRODUCT_STATUSES.includes(params.status as ProductStatus) ? (params.status as ProductStatus) : undefined;
  // Service role after requireAdmin: only counts and hashes are read.
  const service = createSupabaseServiceClient();
  const [products, index, photos] = await Promise.all([
    listAdminProducts({ query, status }),
    searchIndexStatus(service).catch(() => null),
    photoIndexStatus(service, getVisionEnvironment().imageEmbeddingModel).catch(() => null),
  ]);
  const photosBehind = Boolean(photos?.available && photos.indexed < photos.total);

  return (
    <main className="admin-main">
      <div className="page-head">
        <h1>Products</h1>
        <NavLink className="button-link" href="/admin/products/new"><Plus size={16} /> New product</NavLink>
      </div>

      {index && index.total > 0 ? (
        <section className="panel index-panel" aria-labelledby="index-heading">
          <h2 id="index-heading"><Sparkles size={16} /> Meaning search</h2>
          {index.available ? (
            <>
              <p className="muted">
                {index.indexed} of {index.total} live products can be found by meaning, so words like &quot;chadar&quot; or &quot;burqa&quot; find
                the right item even if they aren&apos;t in its name. Products update on their own when you edit them.
              </p>
              {photos ? (
                <p className="muted">
                  {!photos.available
                    ? "Photo matching is off until the database migration 202610060002_product_image_embeddings.sql is applied in Supabase."
                    : photos.total
                      ? `${photos.indexed} of ${photos.total} product photos can be matched when a customer sends a picture, such as a screenshot of your post. New photos are added on their own.`
                      : "Photo matching starts on its own once live products have photos."}
                </p>
              ) : null}
              {index.indexed < index.total || photosBehind ? (
                <ActionButton action={rebuildSearchIndex} label="Update search index" pendingLabel="Updating… (up to a minute)" variant="secondary" />
              ) : null}
            </>
          ) : (
            <p className="muted">Off until the database migration 202609290004_product_embeddings.sql is applied in Supabase.</p>
          )}
        </section>
      ) : null}

      <Form action="/admin/products" className="filter-bar" role="search">
        <input name="q" defaultValue={query} placeholder="Search name, SKU or category" aria-label="Search products" />
        <select name="status" defaultValue={status ?? ""} aria-label="Status">
          <option value="">All statuses</option>
          {PRODUCT_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button type="submit" className="secondary">Filter</button>
      </Form>

      {products.length === 0 ? (
        <p className="empty-state">{query || status ? "No products match these filters." : "No products yet. Create the first one."}</p>
      ) : (
        <ul className="product-list">
          {products.map((product) => (
            <li key={product.id}>
              <NavLink href={`/admin/products/${product.id}`} className="product-row">
                {product.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- public Supabase URL, no optimizer needed for thumbnails
                  <img src={product.thumbnailUrl} alt="" width={56} height={56} loading="lazy" />
                ) : (
                  <span className="thumb-placeholder" aria-hidden="true"><ImageOff size={18} /></span>
                )}
                <span className="product-row-main">
                  <strong>{product.name}</strong>
                  <span className="muted">{product.sku} · {product.category}</span>
                </span>
                <span className="product-row-meta">
                  <span>{pkr.format(product.pricePkr)}</span>
                  <span className="muted">{product.sizesInStock}/{product.sizeCount} sizes in stock</span>
                </span>
                <span className={`status-badge ${product.status}`}>{product.status}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
