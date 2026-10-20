-- Semantic product search. Each product gets an embedding of its text (name, category, colour, fabric,
-- tags, aliases, description and the AI photo description), so words the keyword vocabulary doesn't know
-- ("frock", "maxi", "pishwas", misspellings) still find the right items.

create extension if not exists vector with schema extensions;

alter table public.products
  add column if not exists embedding extensions.vector(768),
  -- Hash of the text that was embedded, so unchanged products aren't embedded again.
  add column if not exists embedding_source_hash text check (embedding_source_hash is null or length(embedding_source_hash) <= 128);

create index if not exists products_embedding_hnsw_idx on public.products
  using hnsw (embedding extensions.vector_cosine_ops);

-- Brain (service role): active products closest in meaning to a query embedding.
create or replace function public.match_products(
  query_embedding extensions.vector(768),
  match_count integer default 8,
  min_similarity double precision default 0.5
)
returns table (id uuid, similarity double precision)
language sql
stable
security invoker
set search_path = pg_catalog, public, extensions
as $$
  select p.id, 1 - (p.embedding <=> query_embedding) as similarity
  from public.products p
  where p.status = 'active'
    and p.embedding is not null
    and 1 - (p.embedding <=> query_embedding) >= min_similarity
  order by p.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$$;

revoke execute on function public.match_products(extensions.vector, integer, double precision) from public, anon, authenticated;
grant execute on function public.match_products(extensions.vector, integer, double precision) to service_role;
