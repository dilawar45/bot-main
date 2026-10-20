"use client";

import { ImagePlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_MIME_TYPES, type ProductImageMimeType } from "@/catalog/admin/validation";
import { analyzeProductImage } from "../ai-actions";
import { attachProductImage, createProductImageUpload } from "../actions";

export function ImageUploader({ productId, aiEnabled }: { productId: string; aiEnabled: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error" | "ok"; text?: string }>({ kind: "idle" });

  async function uploadOne(file: File): Promise<string | null> {
    if (!PRODUCT_IMAGE_MIME_TYPES.includes(file.type as ProductImageMimeType)) return `${file.name}: use JPEG, PNG or WebP.`;
    if (file.size > PRODUCT_IMAGE_MAX_BYTES) return `${file.name}: larger than 10 MB.`;

    const grant = await createProductImageUpload(productId, file.type, file.size);
    if (!grant.ok) return `${file.name}: ${grant.error}`;

    // Bytes go browser → Supabase Storage directly, keeping them off the Vercel function body limit.
    const upload = await fetch(grant.signedUrl, {
      method: "PUT",
      headers: { "content-type": file.type, "x-upsert": "false", "cache-control": "max-age=31536000" },
      body: file,
    });
    if (!upload.ok) return `${file.name}: upload failed (${upload.status}).`;

    const attached = await attachProductImage(productId, grant.objectPath);
    if (attached.error || !attached.imageId) return `${file.name}: ${attached.error ?? "not saved"}`;

    if (aiEnabled) {
      setStatus({ kind: "busy", text: `Analysing ${file.name}…` });
      const analysis = await analyzeProductImage(productId, attached.imageId);
      if (analysis.error) return `${file.name} uploaded, but ${analysis.error}`;
    }
    return null;
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = [...files].slice(0, 10);
    setStatus({ kind: "busy", text: `Uploading ${list.length} image${list.length > 1 ? "s" : ""}…` });

    const errors: string[] = [];
    for (const file of list) {
      try {
        const error = await uploadOne(file);
        if (error) errors.push(error);
      } catch {
        errors.push(`${file.name}: network error.`);
      }
    }

    if (inputRef.current) inputRef.current.value = "";
    setStatus(errors.length ? { kind: "error", text: errors.join(" ") } : { kind: "ok", text: "Images added." });
    router.refresh();
  }

  return (
    <div className="image-uploader">
      <label className={`upload-drop${status.kind === "busy" ? " busy" : ""}`}>
        <ImagePlus size={20} />
        <span>{status.kind === "busy" ? status.text : "Add images (JPEG, PNG, WebP · up to 10 MB each)"}</span>
        <input
          ref={inputRef}
          type="file"
          accept={PRODUCT_IMAGE_MIME_TYPES.join(",")}
          multiple
          disabled={status.kind === "busy"}
          onChange={(event) => void handleFiles(event.target.files)}
        />
      </label>
      {status.kind === "error" ? <p className="form-status error" role="alert">{status.text}</p> : null}
      {status.kind === "ok" ? <p className="form-status ok" role="status">{status.text}</p> : null}
    </div>
  );
}
