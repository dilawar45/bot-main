// Creates (or reuses) the Supabase Auth user for ADMIN_EMAIL and grants admin_users membership.
// Usage (from apps/web):  ADMIN_PASSWORD='...' node scripts/create-admin.mjs
// The password is only sent to Supabase Auth; it is never written to disk.
import { readFileSync } from "node:fs";

function loadEnv(path) {
  const entries = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    });
  return Object.fromEntries(entries);
}

const env = { ...loadEnv(".env.local"), ...process.env };
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const email = env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;

if (!url || !serviceKey || !email) throw new Error("NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ADMIN_EMAIL are required.");

const headers = { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "content-type": "application/json" };

async function call(path, init = {}) {
  const response = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const body = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  return body ? JSON.parse(body) : null;
}

async function findUser() {
  for (let page = 1; page <= 20; page += 1) {
    const { users } = await call(`/auth/v1/admin/users?page=${page}&per_page=100`);
    const match = users.find((user) => user.email?.toLowerCase() === email);
    if (match) return match;
    if (users.length < 100) return null;
  }
  return null;
}

let user = await findUser();
if (user) {
  console.log("Auth user already exists; reusing it.");
} else {
  if (!password || password.length < 12) throw new Error("Set ADMIN_PASSWORD (at least 12 characters) to create the admin user.");
  user = await call("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
  console.log("Auth user created.");
}

await call("/rest/v1/admin_users?on_conflict=user_id", {
  method: "POST",
  headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
  body: JSON.stringify({ user_id: user.id }),
});
console.log("admin_users membership ensured.");
