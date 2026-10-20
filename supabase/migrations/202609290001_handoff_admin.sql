-- Handoff lifecycle and admin controls for conversations.

-- Private owner note per conversation (never sent to the customer).
alter table public.conversations
  add column if not exists internal_note text check (internal_note is null or length(internal_note) <= 2000);

-- Admin may update conversations (resume bot, notes). Reads were already allowed.
drop policy if exists "admin updates conversations" on public.conversations;
create policy "admin updates conversations" on public.conversations
for update to authenticated
using ((select app_private.is_catalog_admin()))
with check ((select app_private.is_catalog_admin()));

-- Admin may update contacts (correct a customer's name/location).
drop policy if exists "admin updates contacts" on public.contacts;
create policy "admin updates contacts" on public.contacts
for update to authenticated
using ((select app_private.is_catalog_admin()))
with check ((select app_private.is_catalog_admin()));

-- Pause the bot, open a handoff and create/update the lead in one transaction.
-- Called by the brain with the service role only.
create or replace function public.begin_handoff(
  p_conversation_id uuid,
  p_reason text,
  p_notification_action_id uuid,
  p_interested_product_ids uuid[] default '{}'
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_id uuid;
begin
  update public.conversations
  set state = 'human_active'
  where id = p_conversation_id
  returning contact_id into v_contact_id;

  if v_contact_id is null then
    raise exception 'conversation % not found', p_conversation_id;
  end if;

  insert into public.handoffs (conversation_id, reason, notification_action_id)
  values (p_conversation_id, left(p_reason, 500), p_notification_action_id);

  insert into public.leads as l (contact_id, conversation_id, interested_product_ids, customer_name, location, handoff_reason)
  select c.id, p_conversation_id, coalesce(p_interested_product_ids, '{}'), c.customer_name, c.location, left(p_reason, 500)
  from public.contacts c
  where c.id = v_contact_id
  on conflict (conversation_id) do update
  set
    interested_product_ids = (
      select coalesce(array_agg(distinct product_id), '{}')
      from unnest(l.interested_product_ids || excluded.interested_product_ids) as product_id
    ),
    customer_name = coalesce(excluded.customer_name, l.customer_name),
    location = coalesce(excluded.location, l.location),
    handoff_reason = excluded.handoff_reason,
    status = case when l.status = 'closed' then 'new' else l.status end,
    updated_at = now();
end;
$$;

revoke execute on function public.begin_handoff(uuid, text, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.begin_handoff(uuid, text, uuid, uuid[]) to service_role;

-- Owner hands the chat back to the bot: resolves open handoffs and resumes automation atomically.
-- Runs as the caller, so RLS limits it to the catalog admin.
create or replace function public.resume_bot(p_conversation_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not (select app_private.is_catalog_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.conversations set state = 'bot_active' where id = p_conversation_id;
  if not found then
    raise exception 'conversation % not found', p_conversation_id;
  end if;

  update public.handoffs
  set resolved_at = now(), accepted_at = coalesce(accepted_at, now())
  where conversation_id = p_conversation_id and resolved_at is null;
end;
$$;

revoke execute on function public.resume_bot(uuid) from public, anon;
grant execute on function public.resume_bot(uuid) to authenticated;

-- Record a failed support alert on the handoff so the admin can see it.
create index if not exists handoffs_notification_action_idx on public.handoffs (notification_action_id);
