  -- Follow-ups on orders. The gateway asks the brain every few minutes (POST /api/gateway/followups) what is
  -- due: one gentle reminder to a customer who saw their priced summary but never confirmed it, and a note to
  -- the owner about carts that went quiet and placed orders still waiting for confirmation. These columns make
  -- sure each follow-up goes out at most once. Safe to run once in the SQL Editor; the code works without it
  -- (follow-ups simply stay off) and switches them on by itself once it is applied.
  
  alter table public.orders
    -- When the customer was shown the current summary (stamped by the trigger below).
    add column if not exists summary_sent_at timestamptz,
    -- The one reminder the customer got about that summary.
    add column if not exists reminder_sent_at timestamptz,
    -- The owner was told this cart went quiet.
    add column if not exists cart_alerted_at timestamptz,
    -- The owner was reminded that this placed order still needs confirming.
    add column if not exists confirm_reminded_at timestamptz;
  
  -- A new or changed summary is a fresh start: stamp it and allow one new reminder and alert. The bot saves the
  -- draft through save_order_draft, so stamping here keeps the timing right without changing that function.
  create or replace function public.stamp_order_summary()
  returns trigger
  language plpgsql
  set search_path = ''
  as $$
  declare
    v_changed boolean;
  begin
    if tg_op = 'INSERT' then
      v_changed := new.summary_fingerprint is not null;
    else
      v_changed := new.summary_fingerprint is not null and new.summary_fingerprint is distinct from old.summary_fingerprint;
    end if;
    if v_changed then
      new.summary_sent_at := now();
      new.reminder_sent_at := null;
      new.cart_alerted_at := null;
    end if;
    return new;
  end;
  $$;
  
  revoke execute on function public.stamp_order_summary() from public, anon, authenticated;
  
  drop trigger if exists orders_stamp_summary on public.orders;
  create trigger orders_stamp_summary before insert or update of summary_fingerprint on public.orders
  for each row execute function public.stamp_order_summary();
  
  -- Carts with a summary out, looked up every few minutes.
  create index if not exists orders_cart_followups_idx on public.orders (summary_sent_at)
    where status = 'draft' and summary_sent_at is not null;
