-- WhatsApp may identify a customer by a privacy "@lid" id instead of their number.
-- Keep the real number separately (when WhatsApp reveals it) for the owner's tap-to-chat links.
alter table public.contacts
  add column if not exists phone_number text check (phone_number is null or phone_number ~ '^[0-9]{6,15}$');
