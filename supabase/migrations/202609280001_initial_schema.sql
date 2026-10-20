create schema if not exists extensions;
create schema if not exists app_private;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create type public.product_status as enum ('draft', 'active', 'archived');
create type public.conversation_state as enum ('bot_active', 'handoff_requested', 'human_active');
create type public.message_direction as enum ('inbound', 'outbound');
create type public.message_source as enum ('customer', 'agent', 'human', 'system');
create type public.delivery_state as enum ('pending', 'sent', 'failed');

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique check (length(trim(sku)) > 0),
  name text not null check (length(trim(name)) > 0),
  description text not null default '',
  category text not null,
  color text,
  material text,
  style_tags text[] not null default '{}',
  aliases text[] not null default '{}',
  price_pkr integer not null check (price_pkr >= 0),
  status public.product_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null unique,
  sort_order integer not null default 0 check (sort_order >= 0),
  ai_description text,
  ai_attributes jsonb not null default '{}'::jsonb,
  extraction_status text not null default 'pending' check (extraction_status in ('pending', 'complete', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  size_label text not null check (length(trim(size_label)) > 0),
  normalized_size text not null check (length(trim(normalized_size)) > 0),
  variant_sku text unique,
  stock_qty integer not null default 0 check (stock_qty >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, normalized_size)
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  whatsapp_chat_id text not null unique,
  display_name text,
  customer_name text,
  location text,
  preferred_language text check (preferred_language in ('en', 'ur', 'roman_ur')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  state public.conversation_state not null default 'bot_active',
  active_product_id uuid references public.products(id) on delete set null,
  summary text,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  provider_message_id text unique,
  event_id text unique,
  direction public.message_direction not null,
  source public.message_source not null,
  content_type text not null check (content_type in ('text', 'image')),
  text_content text,
  media_path text,
  reply_action_id uuid unique,
  delivery_state public.delivery_state,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (text_content is not null or media_path is not null)
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  interested_product_ids uuid[] not null default '{}',
  customer_name text,
  location text,
  status text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  handoff_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id)
);

create table public.handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reason text not null,
  requested_at timestamptz not null default now(),
  accepted_at timestamptz,
  resolved_at timestamptz,
  notification_action_id uuid,
  notification_error text
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  inbound_message_id uuid references public.messages(id) on delete set null,
  prompt_version text not null,
  model text not null,
  candidate_product_ids uuid[] not null default '{}',
  candidate_scores jsonb not null default '{}'::jsonb,
  outcome text not null,
  latency_ms integer check (latency_ms >= 0),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  error_code text,
  created_at timestamptz not null default now()
);

create index products_name_trgm_idx on public.products using gin (name gin_trgm_ops);
create index products_category_idx on public.products (category) where status = 'active';
create index product_images_product_id_idx on public.product_images (product_id);
create index product_variants_product_stock_idx on public.product_variants (product_id, stock_qty);
create index messages_conversation_occurred_idx on public.messages (conversation_id, occurred_at desc);
create index conversations_active_product_id_idx on public.conversations (active_product_id);
create index conversations_state_last_message_idx on public.conversations (state, last_message_at desc);
create index leads_contact_id_idx on public.leads (contact_id);
create index handoffs_conversation_id_idx on public.handoffs (conversation_id);
create index handoffs_open_idx on public.handoffs (requested_at desc) where resolved_at is null;
create index agent_runs_conversation_id_idx on public.agent_runs (conversation_id);
create index agent_runs_inbound_message_id_idx on public.agent_runs (inbound_message_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_set_updated_at before update on public.products
for each row execute function public.set_updated_at();
create trigger product_images_set_updated_at before update on public.product_images
for each row execute function public.set_updated_at();
create trigger product_variants_set_updated_at before update on public.product_variants
for each row execute function public.set_updated_at();
create trigger contacts_set_updated_at before update on public.contacts
for each row execute function public.set_updated_at();
create trigger conversations_set_updated_at before update on public.conversations
for each row execute function public.set_updated_at();
create trigger leads_set_updated_at before update on public.leads
for each row execute function public.set_updated_at();

create or replace function public.search_catalog(search_query text, result_limit integer default 5)
returns table (
  id uuid,
  sku text,
  name text,
  description text,
  category text,
  color text,
  material text,
  price_pkr integer,
  similarity_score real,
  variants jsonb
)
language sql
stable
security invoker
set search_path = pg_catalog, public, extensions
as $$
  select
    p.id,
    p.sku,
    p.name,
    p.description,
    p.category,
    p.color,
    p.material,
    p.price_pkr,
    greatest(
      similarity(lower(p.name), lower(search_query)),
      similarity(lower(p.category), lower(search_query)),
      similarity(lower(coalesce(p.color, '')), lower(search_query)),
      similarity(lower(coalesce(p.material, '')), lower(search_query))
    )::real as similarity_score,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'size', v.size_label,
          'normalizedSize', v.normalized_size,
          'stockQty', v.stock_qty
        ) order by v.normalized_size
      ) filter (where v.id is not null),
      '[]'::jsonb
    ) as variants
  from public.products p
  left join public.product_variants v on v.product_id = p.id
  where p.status = 'active'
    and (
      p.sku ilike '%' || search_query || '%'
      or p.name % search_query
      or p.category % search_query
      or coalesce(p.color, '') % search_query
      or coalesce(p.material, '') % search_query
      or search_query = any(p.aliases)
    )
  group by p.id
  order by similarity_score desc, p.name
  limit greatest(1, least(result_limit, 10));
$$;

alter table public.products enable row level security;
alter table public.admin_users enable row level security;
alter table public.product_images enable row level security;
alter table public.product_variants enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.leads enable row level security;
alter table public.handoffs enable row level security;
alter table public.agent_runs enable row level security;

create or replace function app_private.is_catalog_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  );
$$;

revoke all on schema app_private from public, anon;
grant usage on schema app_private to authenticated;
revoke execute on function app_private.is_catalog_admin() from public, anon;
grant execute on function app_private.is_catalog_admin() to authenticated;

create policy "admin reads own membership" on public.admin_users
for select to authenticated
using (user_id = (select auth.uid()));

create policy "admin manages products" on public.products for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin manages product images" on public.product_images for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin manages variants" on public.product_variants for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin reads contacts" on public.contacts for select using ((select app_private.is_catalog_admin()));
create policy "admin reads conversations" on public.conversations for select using ((select app_private.is_catalog_admin()));
create policy "admin reads messages" on public.messages for select using ((select app_private.is_catalog_admin()));
create policy "admin manages leads" on public.leads for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin manages handoffs" on public.handoffs for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin reads agent runs" on public.agent_runs for select using ((select app_private.is_catalog_admin()));