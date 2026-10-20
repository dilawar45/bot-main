import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/auth/admin";
import { getAdminProduct } from "@/catalog/admin/queries";
import { getPublishBlockers } from "@/catalog/admin/validation";
import { getVisionEnvironment } from "@/config/env";
import { deleteProductImage, moveProductImage, saveVariants, setProductStatus, updateProduct } from "../actions";
import { ActionButton } from "../_components/action-button";
import { ImageUploader } from "../_components/image-uploader";
import { ProductForm } from "../_components/product-form";
import { SuggestionsPanel } from "../_components/suggestions-panel";
import { VariantsEditor } from "../_components/variants-editor";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const product = await getAdminProduct(id);
  if (!product) notFound();

  const aiEnabled = getVisionEnvironment().geminiKeys.length > 0;
  const blockers = getPublishBlockers({ ...product, imageCount: product.images.length, variantCount: product.variants.length });

  return (
    <main className="admin-main">
      <p className="breadcrumb"><Link href="/admin/products">Products</Link> / {product.sku}</p>
      <div className="page-head">
        <h1>{product.name}</h1>
        <span className={`status-badge ${product.status}`}>{product.status}</span>
      </div>

      <section className="panel status-panel" aria-labelledby="status-heading">
        <h2 id="status-heading">Visibility</h2>
        {product.status === "active" ? (
          <p className="muted">Live. The bot can offer this product to customers.</p>
        ) : blockers.length ? (
          <ul className="blocker-list">{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        ) : (
          <p className="muted">Ready to publish.</p>
        )}
        <div className="button-row">
          {product.status !== "active" ? (
            <ActionButton action={setProductStatus.bind(null, product.id, "active")} label="Publish" pendingLabel="Publishing…" />
          ) : (
            <ActionButton action={setProductStatus.bind(null, product.id, "draft")} label="Move to draft" variant="secondary" />
          )}
          {product.status !== "archived" ? (
            <ActionButton
              action={setProductStatus.bind(null, product.id, "archived")}
              label="Archive"
              variant="danger"
              confirmText="Archive this product? The bot will stop offering it. You can restore it later."
            />
          ) : null}
        </div>
      </section>

      <section className="panel" aria-labelledby="images-heading">
        <h2 id="images-heading">Images</h2>
        {product.images.length ? (
          <ul className="image-grid">
            {product.images.map((image, index) => (
              <li key={image.id}>
                {/* eslint-disable-next-line @next/next/no-img-element -- public Supabase URL */}
                <img src={image.url} alt={`${product.name} image ${index + 1}`} loading="lazy" />
                {index === 0 ? <span className="cover-tag">Cover</span> : null}
                <div className="image-tools">
                  <ActionButton action={moveProductImage.bind(null, product.id, image.id, "up")} variant="icon" ariaLabel="Move image earlier"><ArrowUp size={15} /></ActionButton>
                  <ActionButton action={moveProductImage.bind(null, product.id, image.id, "down")} variant="icon" ariaLabel="Move image later"><ArrowDown size={15} /></ActionButton>
                  <ActionButton action={deleteProductImage.bind(null, product.id, image.id)} variant="icon" ariaLabel="Delete image" confirmText="Delete this image?"><Trash2 size={15} /></ActionButton>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No images yet. The first image is the cover the bot sends.</p>
        )}
        <ImageUploader productId={product.id} aiEnabled={aiEnabled} />
      </section>

      <SuggestionsPanel productId={product.id} productName={product.name} category={product.category} images={product.images} aiEnabled={aiEnabled} />

      <section className="panel" aria-labelledby="sizes-heading">
        <h2 id="sizes-heading">Sizes and stock</h2>
        <p className="muted">Customers are told a size is available only when stock is above 0. Exact counts are never shared.</p>
        {/* Keyed by the saved values: after a save the editor restarts from the new stock. */}
        <VariantsEditor key={JSON.stringify(product.variants)} action={saveVariants.bind(null, product.id)} variants={product.variants} />
      </section>

      <section className="panel" aria-labelledby="details-heading">
        <h2 id="details-heading">Details</h2>
        {/* Remount on change so uncontrolled inputs never hold stale values (e.g. after AI fill). */}
        <ProductForm key={product.updatedAt} action={updateProduct.bind(null, product.id)} defaults={product} submitLabel="Save details" />
      </section>
    </main>
  );
}
