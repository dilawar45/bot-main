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