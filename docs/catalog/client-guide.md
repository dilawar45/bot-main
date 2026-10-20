# Naye products kaise bhejein / How to send new products

Send this to the shop owner (a formatted copy for phones: the "Product Bhejne Ka Tareeqa" artifact).

## Har product ke liye 3 zaroori cheezein / Three things for every product

1. **Code** — product ka chhota code (K12, A-7). Har product ka alag. / A short code, different for every product. Photos are matched by it.
2. **Price** — sirf number: `3500` / just the number.
3. **Sizes aur ginti** / sizes with how many of each — `S2 M3 L1`, `Free 5`, `32-2 34-1`. Khatam size na likhein ya `M0`. / Leave out sizes you don't have, or write `M0`.

Agar maloom ho / if you know: kapra (lawn, cotton, khaddar, chiffon), 2 / 3 piece, dupatta, stitched ya unstitched. Naam aur category zaroori nahi: photo se likh li jaati hain. / The name and category are written from the photo.

## Photos

- 1–4 photos per product; pehli photo: poora kapra saamne se / the first photo shows the whole piece from the front.
- Din ki roshni, saada background, WhatsApp par HD. / Daylight, plain background, HD on WhatsApp.
- Na bhejein / don't send: screenshots, collages, text or prices on the photo, several products in one photo.

## Kaise bhejein / How to send

**WhatsApp (asaan / easiest):** ek product ki saari photos ek saath bhejein, aur pehli photo ke caption mein ye line likh dein / send one product's photos together, with this line as the first photo's caption:

```
K12 | 3500 | S2 M3 L1 | lawn, 3 piece
```

code | price | sizes | baaqi tafseel (other details), separated by `|`. Phir agla product, apne alag message mein / then the next product, in its own message. Caption mein sirf code (`K12`) likh kar line alag message mein bhi bhej sakte hain / or put just the code in the caption and send the line as its own message. Pehle saari photos aur aakhir mein saari lines ek saath na bhejein / don't send all the photos first and all the lines at the end.

**Google Sheet + Drive (zyada products / many products):** columns `code, price, sizes, name, category, colour, fabric, notes` (the first three required); photos named `K12-1.jpg`, `K12-2.jpg` or one folder per code (`K12`).

## Stock badle to / When stock changes

Wahi code, nayi ginti: `K12 | 3500 | S0 M1 L2`. Purana product update hota hai. / Same code, new counts: the existing product is updated.

---

## For the operator: turning it into products

1. On the phone: the shop's chat → ⋮ → More → Export chat → **Include media**. Put the `.zip` in `catalog/` at the repo root (git ignores it); it's unpacked there on the next run. (A sheet: download it as CSV into `catalog/`, with the photos from Drive next to it.)
2. `pnpm import:products ./catalog --dry-run` — lists each product with its photos (matched by the code in the caption, the photos sent with it, or the line next to them), what the AI will fill, and problems. Open `import-preview.html` (next to the chat) to check every product's photos by eye.
3. `pnpm import:products ./catalog --publish` — creates or updates the products, fills name/category/colour/fabric/tags/description from the main photo, puts complete products live and adds them to search. The rest stay drafts with the reason in the output.

Next batch: export the chat again and replace the `.zip`. Products already imported show as unchanged; the latest line per code wins, and a new stock line is applied less the orders confirmed after it was sent, so sold stock never comes back. Only the shop's messages count: your own questions and photos in that chat are skipped.
