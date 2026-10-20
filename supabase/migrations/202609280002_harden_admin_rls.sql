create schema if not exists app_private;

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

drop policy if exists "admin reads own membership" on public.admin_users;
create policy "admin reads own membership" on public.admin_users
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "admin manages products" on public.products;
drop policy if exists "admin manages product images" on public.product_images;
drop policy if exists "admin manages variants" on public.product_variants;
drop policy if exists "admin reads contacts" on public.contacts;
drop policy if exists "admin reads conversations" on public.conversations;
drop policy if exists "admin reads messages" on public.messages;
drop policy if exists "admin manages leads" on public.leads;
drop policy if exists "admin manages handoffs" on public.handoffs;
drop policy if exists "admin reads agent runs" on public.agent_runs;

create policy "admin manages products" on public.products for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin manages product images" on public.product_images for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin manages variants" on public.product_variants for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin reads contacts" on public.contacts for select using ((select app_private.is_catalog_admin()));
create policy "admin reads conversations" on public.conversations for select using ((select app_private.is_catalog_admin()));
create policy "admin reads messages" on public.messages for select using ((select app_private.is_catalog_admin()));
create policy "admin manages leads" on public.leads for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin manages handoffs" on public.handoffs for all using ((select app_private.is_catalog_admin())) with check ((select app_private.is_catalog_admin()));
create policy "admin reads agent runs" on public.agent_runs for select using ((select app_private.is_catalog_admin()));

drop function if exists public.is_catalog_admin();

create index if not exists product_images_product_id_idx on public.product_images (product_id);
create index if not exists conversations_active_product_id_idx on public.conversations (active_product_id);
create index if not exists leads_contact_id_idx on public.leads (contact_id);
create index if not exists handoffs_conversation_id_idx on public.handoffs (conversation_id);
create index if not exists agent_runs_conversation_id_idx on public.agent_runs (conversation_id);
create index if not exists agent_runs_inbound_message_id_idx on public.agent_runs (inbound_message_id);