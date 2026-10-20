-- Photo search. The first few photos of every active product get an image embedding (gemini-embedding-2), so a
-- customer's photo — often a screenshot of the shop's own Instagram/Facebook post — finds the product it shows.
-- Image similarity only ranks candidates; the reply model compares the photos before calling it the same item.

create extension if not exists vector with schema extensions;

alter table public.product_images
  add column if not exists image_embedding extensions.vector(768),
  -- Hash of the model and storage path that were embedded, so unchanged photos aren't embedded again.
  add column if not exists image_embedding_hash text check (image_embedding_hash is null or length(image_embedding_hash) <= 128);

create index if not exists product_images_image_embedding_hnsw_idx on public.product_images
  using hnsw (image_embedding extensions.vector_cosine_ops);

-- Brain (service role): active products whose photos look most like the query photo, best photo per product.
-- The inner query is a plain nearest-neighbour scan (served by the HNSW index); products are filtered and
-- grouped afterwards, from a few candidates per requested product.
create or replace function public.match_product_images(
  query_embedding extensions.vector(768),
  match_count integer default 6,
  min_similarity double precision default 0.5
)
returns table (product_id uuid, storage_path text, similarity double precision)
language sql
stable
security invoker
set search_path = pg_catalog, public, extensions
as $$
  with nearest as (
    select pi.product_id, pi.storage_path, pi.image_embedding <=> query_embedding as distance
    from public.product_images pi
    where pi.image_embedding is not null
    order by pi.image_embedding <=> query_embedding
    -- At most 40, hnsw.ef_search's default: an index scan returns no more than that anyway.
    limit greatest(1, least(match_count, 10)) * 4
  ),
  best as (
    select distinct on (n.product_id) n.product_id, n.storage_path, 1 - n.distance as similarity
    from nearest n
    join public.products p on p.id = n.product_id and p.status = 'active'
    order by n.product_id, n.distance
  )
  select b.product_id, b.storage_path, b.similarity
  from best b
  where b.similarity >= min_similarity
  order by b.similarity desc
  limit greatest(1, least(match_count, 10));
$$;

revoke execute on function public.match_product_images(extensions.vector, integer, double precision) from public, anon, authenticated;
grant execute on function public.match_product_images(extensions.vector, integer, double precision) to service_role;
