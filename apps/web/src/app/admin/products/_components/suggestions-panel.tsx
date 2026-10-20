import { Sparkles } from "lucide-react";
import type { AdminProductImage } from "@/catalog/admin/queries";
import { analyzeProductImage, applyImageSuggestion } from "../ai-actions";
import { ActionButton } from "./action-button";

export function SuggestionsPanel({
  productId,
  productName,
  category,
  images,
  aiEnabled,
}: {
  productId: string;
  productName: string;
  category: string;
  images: AdminProductImage[];
  aiEnabled: boolean;
}) {
  return (
    <section className="panel" aria-labelledby="ai-heading">
      <h2 id="ai-heading"><Sparkles size={16} /> AI suggestions</h2>
      <p className="muted">
        Gemini looks at each photo and suggests colour, material, tags and a description. Filling only touches empty fields and never
        sets price, sizes or stock.
      </p>
      {!aiEnabled ? <p className="form-status error">Set GEMINI_API_KEY on the server to turn this on.</p> : null}
      {images.length === 0 ? <p className="muted">Upload an image to get suggestions.</p> : null}
      <ul className="suggestion-list">
        {images.map((image, index) => {
          const suggestion = image.suggestion;
          return (
            <li key={image.id} className="suggestion-card">
              {/* eslint-disable-next-line @next/next/no-img-element -- public Supabase URL */}
              <img src={image.url} alt={`${productName} image ${index + 1}`} loading="lazy" />
              <div className="suggestion-body">
                {suggestion && suggestion.isProduct ? (
                  <>
                    <dl>
                      <dt>Category</dt>
                      <dd>
                        {suggestion.category ?? "—"}
                        {suggestion.category && suggestion.category !== category ? <span className="muted"> (yours: {category})</span> : null}
                      </dd>
                      <dt>Colour</dt>
                      <dd>{suggestion.color ?? "—"}</dd>
                      <dt>Material</dt>
                      <dd>{suggestion.material ?? "—"}</dd>
                      <dt>Tags</dt>
                      <dd>{suggestion.styleTags.join(", ") || "—"}</dd>
                      <dt>Description</dt>
                      <dd>{suggestion.description ?? "—"}</dd>
                    </dl>
                    <p className="muted small">AI suggested · {Math.round(suggestion.confidence * 100)}% confident · {suggestion.model}</p>
                  </>
                ) : suggestion ? (
                  <p className="muted">This photo doesn&apos;t look like a product.</p>
                ) : image.aiStatus === "failed" ? (
                  <p className="form-status error">Last analysis failed.</p>
                ) : (
                  <p className="muted">Not analysed yet.</p>
                )}
                <div className="button-row">
                  {suggestion?.isProduct ? (
                    <ActionButton action={applyImageSuggestion.bind(null, productId, image.id)} label="Fill empty fields" pendingLabel="Filling…" />
                  ) : null}
                  {aiEnabled ? (
                    <ActionButton
                      action={analyzeProductImage.bind(null, productId, image.id)}
                      label={suggestion || image.aiStatus === "failed" ? "Analyse again" : "Analyse"}
                      pendingLabel="Analysing…"
                      variant="secondary"
                    />
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
