# Operations Runbook

## 1. Supabase

1. Apply every file in `supabase/migrations/` in filename order (SQL Editor or `supabase db push`). Later files depend on earlier ones.
2. The storage buckets (`product-images` public, `inbound-media` private) are created by `202609280004_create_storage_buckets.sql`.
3. Create the admin: from `apps/web`, run `ADMIN_PASSWORD='…' pnpm create-admin`. It creates the Auth user for `ADMIN_EMAIL` and the `admin_users` row. Safe to re-run.
4. Check: sign in at `/login`; Products and Conversations load.

Features that switch on with a migration (the code works without them and turns them on by itself once applied):

| Migration | Turns on |
| --- | --- |
| `202609290002_contact_phone.sql` | Stores the real number behind WhatsApp's hidden "@lid" ids (tap-to-chat links, order phone prefill). |
| `202609290003_orders.sql` | Order taking in WhatsApp and **Admin → Orders**. Until then the bot passes buyers to you. |
| `202609290004_product_embeddings.sql` | Meaning search (pgvector). After applying it, press **Products → Update search index** once. |
| `202610060001_order_followups.sql` | Order follow-ups: one reminder to a customer who saw the priced summary but didn't confirm, and WhatsApp notes to you about quiet carts and placed orders you haven't confirmed (**Shop info → Orders in WhatsApp**). |
| `202610060002_product_image_embeddings.sql` | Photo search: a customer's photo (often a screenshot of your own post) is matched against your product photos, and the AI compares the closest ones by eye before saying it's the same item. After applying it, press **Products → Update search index** once; new photos are indexed by themselves. |

Each file is safe to run once in the SQL Editor (paste the whole file, Run). They were tested on Postgres 17 with pgvector before release.

Never put the service-role key in a `NEXT_PUBLIC_` variable.

## 2. Vercel (web + brain)

1. New project from the repo, **Root Directory `apps/web`**, framework Next.js, Node 22.
2. Environment variables (Production): everything in `apps/web/.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`), `SUPABASE_SERVICE_ROLE_KEY`
   - `GATEWAY_HMAC_SECRET`, `GATEWAY_ADMIN_TOKEN` — same values as Railway
   - `GATEWAY_BASE_URL` — the Railway public URL (e.g. `https://gateway-production.up.railway.app`)
   - `SUPPORT_WA_ID` — owner's alert number, `923001234567@c.us` format
   - `ADMIN_EMAIL`, `STORE_CURRENCY=PKR`
   - `GEMINI_API_KEY` — one key or several comma-separated keys (rotated; a rate-limited key fails over to the next)
   - `GEMINI_MODEL_PRO` (writes every reply, default `gemini-flash-latest`), `GEMINI_MODEL_FALLBACKS` (tried next when that one is slow or overloaded, e.g. `gemini-3.6-flash`), `GEMINI_MODEL_FAST` (chat summaries, and the last resort for replies, default `gemini-flash-lite-latest`)
   - `GEMINI_EMBEDDING_MODEL` (optional, meaning search, default `gemini-embedding-001`; after changing it press **Products → Update search index**)
   - `GEMINI_IMAGE_EMBEDDING_MODEL` (optional, photo search, default `gemini-embedding-2`, which embeds images; after changing it press **Products → Update search index**)
   - `APP_BASE_URL` (optional, e.g. `https://shop.example.com`): links in the owner's new-order alerts. On Vercel the production URL is used automatically.
   - `CRON_SECRET` — random, 16+ chars; Vercel sends it to the daily media cleanup (`vercel.json`)
   - Gemini free tier: keys from one Google project share its limits (about 20 requests a day on `gemini-flash-latest`, a few per minute on the others). For real traffic enable billing on that project; the bot then keeps using the stronger model.
3. Deploy, then open `/login`.

Gateway endpoints (HMAC-signed, `x-huzaifa-timestamp` + `x-huzaifa-signature` = hex SHA-256 HMAC of `<timestamp>.<raw body>`, 5-minute window, 64 KB max):
`POST /api/gateway/messages`, `POST /api/gateway/media-upload`, `POST /api/gateway/deliveries`, `POST /api/gateway/owner-messages`, `POST /api/gateway/followups`.

## 3. Railway (WhatsApp gateway)

1. New service from the repo. Railway reads `apps/gateway/railway.json` (Dockerfile build from the repo root). If asked, set the config path to `apps/gateway/railway.json`.
2. Variables: everything in `apps/gateway/.env.example`, with `BRAIN_BASE_URL` = the Vercel URL, `WHATSAPP_AUTH_PATH=/data/wwebjs-auth`, `WEBHOOK_TIMEOUT_MS=45000` and `PRODUCT_MEDIA_ORIGIN` = your Supabase project URL (required: product photos are only fetched from there). `FOLLOWUP_INTERVAL_MS` (default 300000, 0 = off) is how often the gateway asks the brain for due follow-ups (`POST /api/gateway/followups`); it only asks while WhatsApp is connected.
3. **Volume**: attach a volume mounted at `/data`. Railway mounts volumes as root while the image runs as the `node` user, so also set `RAILWAY_RUN_UID=0`; otherwise the WhatsApp login can't be saved and you'd rescan the QR after every restart.
4. Generate a public domain for the service (needed for `GATEWAY_BASE_URL`).
5. Check `GET /health/live` → 200. Open the admin → WhatsApp and scan the QR with the **bot** phone (WhatsApp → Settings → Linked devices).
6. Redeploy once and confirm the admin shows **Connected** without a new QR.
7. The gateway looks after itself while connected: every minute it checks that WhatsApp Web still answers (three failures in a row restart the browser on the same session, no new QR), a crashed page or browser is restarted at once, and every 5 minutes it looks for unread customer messages that never came through. Those are answered late, with an apology; if they arrived while it looked connected, the hooks are broken and it restarts itself (at most once per 10 minutes, at most 6 automatic restarts an hour). After any start it also answers customers who wrote while it was down: the last 6 hours by day, only the last hour at night (10pm–9am Pakistan time), and in the morning everything since 9pm. Chats from before the number was linked are never answered (the link time is kept in `linked-at` next to the session files). `GET /health/ready` is 503 while not connected or while checks fail; the admin WhatsApp page shows the last message received, the last check, automatic restarts and recovered messages.
8. **whatsapp-web.js patch:** WhatsApp Web renamed message ids in July 2026 (`id._serialized` became `id.$1`). whatsapp-web.js 1.34.7, the latest on npm, still connects and receives messages but fails to download customer photos, list chats (needed to find missed messages) and show "typing…". `patches/whatsapp-web.js@1.34.7.patch` applies the upstream fix (wwebjs PR #201832, merged 2026-09-26, not yet released) on install; the version is pinned to 1.34.7 for it. When a release includes the fix, update the version and delete the patch (`patchedDependencies` in `pnpm-workspace.yaml`). The admin WhatsApp page warns when the chat list can't be read.
9. **A number that is also someone's personal WhatsApp:** set `IGNORE_SAVED_CONTACTS=true`. People saved in that phone's contacts are then never answered by the bot (also not after downtime), and nothing from their chats is stored; the WhatsApp page counts what was ignored. A dedicated shop number is still the better setup.

## 4. Go-live checklist

- Fill **Admin → Shop info** (delivery, payment, returns, hours, address) and paste 20–30 real chats as tone examples.
- Run `pnpm --filter @huzaifa/web eval` and keep the score before/after prompt or model changes.
- Test from a second phone: greeting (bot disclosure appears once), product by name, product by photo, size follow-up ("medium hai?"), sold-out size, "human" → owner alert with wa.me link, owner replies in WhatsApp, bot stays silent, Resume bot in admin, bot answers again.
- Admin → Conversations shows no red "Last 24 hours" problems.
- Change a size's stock to 0 and ask again; the reply must say not in stock.
- Orders (after the orders migration): set the delivery charge in **Shop info**, then order from the second phone: item + size → name, number, address → the priced summary → "confirm". You get a "New order" WhatsApp alert; open it under **Orders**, press **Confirm order** (stock goes down, the customer gets a WhatsApp message), then **Mark as shipped**.
- Meaning search (after the embeddings migration): **Products → Update search index**, then ask for something by another name (e.g. "chadar" for a dupatta).
- Photo search (after the photo migration and with product photos uploaded): **Products → Update search index**, then send a screenshot of one of your product posts from the second phone. The bot should show that product and say it's the one; a photo of something you don't sell should get "don't have that exact one" plus the closest items. Each run's photo matches and timings are in `agent_runs.candidate_scores.photo`.
- Follow-ups (after the follow-ups migration): from the second phone get an order summary and don't answer. During opening hours you get one reminder after the delay set in **Shop info** (default 1 hour), and about an hour later the owner number gets a "🛒 A cart is waiting for a confirm" note; **Orders → Open carts** shows "Summary sent … · reminded …". Reply *confirm* to the reminder and the order is placed as usual.

## 5. Recovery

| Symptom | Action |
| --- | --- |
| Admin WhatsApp page: "not reachable" | Railway service down or wrong `GATEWAY_BASE_URL`. |
| "rejected the admin token" | `GATEWAY_ADMIN_TOKEN` differs between Vercel and Railway. |
| QR shown after every restart | Volume not mounted at `/data`, or `RAILWAY_RUN_UID=0` missing. |
| Stuck "Disconnected" | Restart session in admin; if it persists, Unlink number and rescan. |
| "WhatsApp kept failing… stopped restarting it" | Six automatic restarts in an hour didn't help: check the bot phone is online and still lists the device under Linked devices, then press Restart session (it also resets the count). Still failing: Unlink number and link again. |
| Customer photos arrive without the picture, or the WhatsApp page says it can't read the chat list | whatsapp-web.js is out of step with WhatsApp Web: check that the install applied `patches/whatsapp-web.js@1.34.7.patch` (Railway build log, or `node_modules/.pnpm/whatsapp-web.js@1.34.7_patch*`), then look for a newer whatsapp-web.js release. |
| Connected, but customers get no reply | The gateway notices this itself within ~5 minutes ("WhatsApp stopped reporting incoming messages" in its log), answers the missed messages and restarts the browser. If it keeps happening, check the gateway log for health-check failures and update `whatsapp-web.js`. |
| Friends or family got bot replies | The number is also a personal WhatsApp: set `IGNORE_SAVED_CONTACTS=true` on the gateway (see Railway step 9), or move the bot to a dedicated number. Meanwhile, replying yourself in that chat makes the bot step back there. |
| Customers get the "temporary problem" message | Brain unreachable: check Vercel logs; webhook 401 = HMAC mismatch or clock skew, 503 = missing env. |
| Replies "not delivered" in a chat | WhatsApp not connected at send time; check WhatsApp page. |
| Support alert failed on a handoff | Same as above; the chat stays paused, call the customer from the Conversations page. |
| Bot silent for one customer | You (or someone on the bot phone) replied in that chat, so the bot stepped back — press Resume bot; or the chat sent more than 8 messages in a minute. |
| "AI errors" in admin | Gemini keys invalid, out of quota, or every model overloaded; the bot answers with keyword rules meanwhile (buyers and open orders go to you). Overloaded models are skipped for 5 minutes, rate-limited ones for 1, used-up daily quotas are rechecked hourly. Each run's model attempts and timings are in `agent_runs.candidate_scores.attempts`. |
| "Not enough stock" when confirming an order | Someone bought the last piece meanwhile, or stock was edited. Update stock or cancel the order (with a reason; the customer is told). |
| Order confirmed but the customer wasn't messaged | WhatsApp wasn't connected or the gateway couldn't be reached; the order page says so. Message them from WhatsApp. |
| Orders page says "off until the migration…" | Apply `202609290003_orders.sql`. |
| Meaning search panel says "off" | Apply `202609290004_product_embeddings.sql`, then press **Update search index**. |
| Photo search panel says "off", or photos never match | Apply `202610060002_product_image_embeddings.sql`, then **Update search index**. Only products with photos can be found by photo; `candidate_scores.photo.error` on a run says why a lookup failed. |
| No order reminders or cart notes | Apply `202610060001_order_followups.sql`; check **Shop info** (reminder delay not "Never", notes ticked) and opening hours (nothing is sent while closed, and customers never between 10pm and 9am). Gateway log "Brain has no follow-up endpoint yet" = the web app on Vercel is older than the gateway: redeploy it. A customer gets at most one reminder per summary, only if they haven't written since and wrote within the last day. |
| Stuck at "authenticated" after a restart | The gateway restarts its browser automatically after 2 minutes (up to 3 times); if the admin then says to relink, Unlink number and scan again. |

## 6. Security and privacy

- Use a dedicated WhatsApp number with no irreplaceable history.
- Rotate `GATEWAY_HMAC_SECRET` and `GATEWAY_ADMIN_TOKEN` together (update Vercel and Railway, redeploy both).
- Customer photos are deleted after 30 days by `/api/cron/cleanup-media`; message text stays.
- A customer's data can be deleted from their conversation page (Privacy → Delete customer data).
- Logs never contain image bytes, keys, signed URLs or full phone numbers.
- Review Pakistan's data-protection obligations and your own retention policy before real customer use.
