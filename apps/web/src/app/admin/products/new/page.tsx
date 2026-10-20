import Link from "next/link";
import { requireAdmin } from "@/auth/admin";
import { createProduct } from "../actions";
import { ProductForm } from "../_components/product-form";

export default async function NewProductPage() {
  await requireAdmin();

  return (
    <main className="admin-main">
      <p className="breadcrumb"><Link href="/admin/products">Products</Link> / New</p>
      <h1>New product</h1>
      <p className="muted">Saved as a draft. Add images and sizes on the next screen, then publish.</p>
      <section className="panel">
        <ProductForm action={createProduct} submitLabel="Create draft" />
      </section>
    </main>
  );
}
