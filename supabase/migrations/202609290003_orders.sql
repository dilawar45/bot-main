-- Orders taken by the WhatsApp bot.
-- The bot keeps one draft per chat (items plus delivery details) while it talks to the customer, shows a
-- summary with prices, and places the order when the customer confirms exactly that summary. The owner then
-- confirms, ships, delivers or cancels it in the admin. Stock is taken when the owner confirms, and given
-- back if a confirmed or shipped order is cancelled.

create type public.order_status as enum ('draft', 'placed', 'confirmed', 'shipped', 'delivered', 'cancelled');

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  -- Short number the customer and the owner can quote ("#1024").
  order_number integer generated always as identity (start with 1001) unique,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  status public.order_status not null default 'draft',
  customer_name text check (customer_name is null or length(customer_name) between 1 and 120),
  -- Digits only, with country code for Pakistan (923001234567) or as given for other countries.
  phone text check (phone is null or phone ~ '^[0-9]{10,15}$'),
  address text check (address is null or length(address) between 5 and 400),
  city text check (city is null or length(city) between 2 and 80),
  customer_note text check (customer_note is null or length(customer_note) <= 400),
  items_total_pkr integer not null default 0 check (items_total_pkr >= 0),
  -- Null when the shop hasn't set a fixed delivery fee (the team confirms it).
  delivery_fee_pkr integer check (delivery_fee_pkr is null or delivery_fee_pkr >= 0),
  -- Fingerprint of the items and details in the last summary the customer was shown. Placing an order
  -- requires the same fingerprint, so a customer can only confirm exactly what they saw.
  summary_fingerprint text check (summary_fingerprint is null or length(summary_fingerprint) <= 128),
  internal_note text check (internal_note is null or length(internal_note) <= 2000),
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300),
  placed_at timestamptz,
  confirmed_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One open cart per chat.
create unique index orders_one_draft_per_conversation_idx on public.orders (conversation_id) where status = 'draft';
create index orders_conversation_created_idx on public.orders (conversation_id, created_at desc);
create index orders_status_placed_idx on public.orders (status, placed_at desc);
create index orders_contact_id_idx on public.orders (contact_id);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  -- Snapshot at the time of ordering: later catalog edits don't change an order.
  product_name text not null,
  sku text not null,
  size_label text not null,
  normalized_size text not null,
  quantity integer not null check (quantity between 1 and 20),
  unit_price_pkr integer not null check (unit_price_pkr >= 0),
  line_number integer not null default 1 check (line_number >= 1),
  created_at timestamptz not null default now()
);

create unique index order_items_line_idx on public.order_items (order_id, product_id, normalized_size);
create index order_items_order_id_idx on public.order_items (order_id);
create index order_items_product_id_idx on public.order_items (product_id);

create trigger orders_set_updated_at before update on public.orders
for each row execute function public.set_updated_at();

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create policy "admin manages orders" on public.orders
for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin manages order items" on public.order_items
for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));

-- Brain (service role): replace the chat's draft cart and details in one transaction.
-- p_items: [{"product_id": "<uuid>", "size": "M", "quantity": 1}, ...]. Names, SKUs and prices are copied
-- from the catalog here, never taken from the caller.
create or replace function public.save_order_draft(
  p_conversation_id uuid,
  p_items jsonb,
  p_customer_name text,
  p_phone text,
  p_address text,
  p_city text,
  p_customer_note text,
  p_delivery_fee_pkr integer,
  p_summary_fingerprint text
)
returns table (order_id uuid, order_number integer, items_total_pkr integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_order_id uuid;
  v_number integer;
  v_total integer;
  v_requested integer;
  v_saved integer;
begin
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'items_not_array' using errcode = '22023';
  end if;
  v_requested := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
  if v_requested > 10 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;

  select c.contact_id into v_contact_id from public.conversations c where c.id = p_conversation_id;
  if v_contact_id is null then
    raise exception 'conversation % not found', p_conversation_id using errcode = 'P0002';
  end if;

  select o.id into v_order_id
  from public.orders o
  where o.conversation_id = p_conversation_id and o.status = 'draft'
  for update;
  if v_order_id is null then
    insert into public.orders (conversation_id, contact_id)
    values (p_conversation_id, v_contact_id)
    returning id into v_order_id;
  end if;

  delete from public.order_items i where i.order_id = v_order_id;
  insert into public.order_items (order_id, product_id, product_name, sku, size_label, normalized_size, quantity, unit_price_pkr, line_number)
  select v_order_id, p.id, p.name, p.sku, v.size_label, v.normalized_size, (e.value ->> 'quantity')::integer, p.price_pkr, e.line::integer
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as e(value, line)
  join public.products p on p.id = (e.value ->> 'product_id')::uuid and p.status = 'active'
  join public.product_variants v on v.product_id = p.id and lower(v.normalized_size) = lower(e.value ->> 'size');
  get diagnostics v_saved = row_count;
  if v_saved <> v_requested then
    raise exception 'unknown_product_or_size' using errcode = '22023';
  end if;

  select coalesce(sum(i.quantity * i.unit_price_pkr), 0)::integer into v_total from public.order_items i where i.order_id = v_order_id;

  update public.orders o
  set
    customer_name = nullif(trim(p_customer_name), ''),
    phone = nullif(trim(p_phone), ''),
    address = nullif(trim(p_address), ''),
    city = nullif(trim(p_city), ''),
    customer_note = nullif(trim(p_customer_note), ''),
    items_total_pkr = v_total,
    delivery_fee_pkr = p_delivery_fee_pkr,
    summary_fingerprint = nullif(trim(p_summary_fingerprint), '')
  where o.id = v_order_id
  returning o.order_number into v_number;

  return query select v_order_id, v_number, v_total;
end;
$$;

revoke execute on function public.save_order_draft(uuid, jsonb, text, text, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.save_order_draft(uuid, jsonb, text, text, text, text, text, integer, text) to service_role;

-- Brain (service role): the customer confirmed the summary they were shown. Checks it is still that
-- summary, complete and in stock, then hands it to the owner. Returns the order number.
create or replace function public.place_order(p_order_id uuid, p_summary_fingerprint text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_short text;
begin
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_order.status <> 'draft' then
    raise exception 'order_not_draft' using errcode = 'P0001';
  end if;
  if v_order.summary_fingerprint is null or v_order.summary_fingerprint is distinct from p_summary_fingerprint then
    raise exception 'summary_outdated' using errcode = 'P0001';
  end if;
  if v_order.customer_name is null or v_order.phone is null or v_order.address is null or v_order.city is null then
    raise exception 'details_missing' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.order_items i where i.order_id = p_order_id) then
    raise exception 'no_items' using errcode = 'P0001';
  end if;

  select string_agg(i.product_name || ' (' || i.size_label || ')', ', ' order by i.line_number) into v_short
  from public.order_items i
  left join public.product_variants v on v.product_id = i.product_id and v.normalized_size = i.normalized_size
  where i.order_id = p_order_id and coalesce(v.stock_qty, 0) < i.quantity;
  if v_short is not null then
    raise exception 'out_of_stock: %', v_short using errcode = 'P0001';
  end if;

  update public.orders o set status = 'placed', placed_at = now() where o.id = p_order_id;
  return v_order.order_number;
end;
$$;

revoke execute on function public.place_order(uuid, text) from public, anon, authenticated;
grant execute on function public.place_order(uuid, text) to service_role;

-- Owner (admin): accept a placed order. Takes the stock for every line, or nothing if any line is short.
create or replace function public.confirm_order(p_order_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status public.order_status;
  v_item record;
begin
  if not (select app_private.is_catalog_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select o.status into v_status from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_status <> 'placed' then
    raise exception 'order_not_placed' using errcode = 'P0001';
  end if;

  for v_item in
    select i.product_id, i.product_name, i.size_label, i.normalized_size, i.quantity
    from public.order_items i
    where i.order_id = p_order_id
    order by i.line_number
  loop
    update public.product_variants v
    set stock_qty = v.stock_qty - v_item.quantity
    where v.product_id = v_item.product_id and v.normalized_size = v_item.normalized_size and v.stock_qty >= v_item.quantity;
    if not found then
      raise exception 'insufficient_stock: % (%)', v_item.product_name, v_item.size_label using errcode = 'P0001';
    end if;
  end loop;

  update public.orders o set status = 'confirmed', confirmed_at = now() where o.id = p_order_id;
end;
$$;

revoke execute on function public.confirm_order(uuid) from public, anon;
grant execute on function public.confirm_order(uuid) to authenticated;

-- Owner (admin): move a confirmed order on (confirmed -> shipped -> delivered).
create or replace function public.advance_order(p_order_id uuid, p_status public.order_status)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status public.order_status;
begin
  if not (select app_private.is_catalog_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select o.status into v_status from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if p_status = 'shipped' and v_status = 'confirmed' then
    update public.orders o set status = 'shipped', shipped_at = now() where o.id = p_order_id;
  elsif p_status = 'delivered' and v_status in ('confirmed', 'shipped') then
    update public.orders o set status = 'delivered', delivered_at = now(), shipped_at = coalesce(o.shipped_at, now()) where o.id = p_order_id;
  else
    raise exception 'invalid_transition: % -> %', v_status, p_status using errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.advance_order(uuid, public.order_status) from public, anon;
grant execute on function public.advance_order(uuid, public.order_status) to authenticated;

-- Owner (admin): cancel an order that isn't delivered. Stock taken at confirmation is given back.
create or replace function public.cancel_order(p_order_id uuid, p_reason text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status public.order_status;
begin
  if not (select app_private.is_catalog_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select o.status into v_status from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_status in ('delivered', 'cancelled') then
    raise exception 'order_not_cancellable' using errcode = 'P0001';
  end if;

  if v_status in ('confirmed', 'shipped') then
    update public.product_variants v
    set stock_qty = v.stock_qty + i.quantity
    from public.order_items i
    where i.order_id = p_order_id and v.product_id = i.product_id and v.normalized_size = i.normalized_size;
  end if;

  update public.orders o
  set status = 'cancelled', cancelled_at = now(), cancel_reason = nullif(left(trim(coalesce(p_reason, '')), 300), '')
  where o.id = p_order_id;
end;
$$;

revoke execute on function public.cancel_order(uuid, text) from public, anon;
grant execute on function public.cancel_order(uuid, text) to authenticated;
