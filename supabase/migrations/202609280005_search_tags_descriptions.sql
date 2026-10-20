-- Widen catalog search: besides name/category/colour/material, also match
-- aliases, style tags, the owner's description and AI image descriptions.
-- Return shape is unchanged, so callers (SupabaseBrainRepository.searchCatalog) need no changes.

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
  with query as (
    select lower(trim(search_query)) as term
  ),
  image_text as (
    select pi.product_id, string_agg(pi.ai_description, ' ') as ai_text
    from public.product_images pi
    where pi.ai_description is not null
    group by pi.product_id
  ),
  scored as (
    select
      p.id,
      p.sku,
      p.name,
      p.description,
      p.category,
      p.color,
      p.material,
      p.price_pkr,
      p.aliases,
      greatest(
        similarity(lower(p.name), query.term),
        similarity(lower(p.category), query.term),
        similarity(lower(coalesce(p.color, '')), query.term),
        similarity(lower(coalesce(p.material, '')), query.term),
        word_similarity(query.term, lower(array_to_string(p.aliases, ' '))),
        word_similarity(query.term, lower(array_to_string(p.style_tags, ' '))) * 0.9,
        word_similarity(query.term, lower(p.description)) * 0.8,
        word_similarity(query.term, lower(coalesce(image_text.ai_text, ''))) * 0.7,
        case when lower(p.sku) = query.term then 1 else 0 end
      )::real as score
    from public.products p
    cross join query
    left join image_text on image_text.product_id = p.id
    where p.status = 'active'
  )
  select
    s.id,
    s.sku,
    s.name,
    s.description,
    s.category,
    s.color,
    s.material,
    s.price_pkr,
    s.score as similarity_score,
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
  from scored s
  left join public.product_variants v on v.product_id = s.id
  where s.score >= 0.3
    or s.sku ilike '%' || search_query || '%'
    or lower(search_query) = any (select lower(alias) from unnest(s.aliases) as alias)
  group by s.id, s.sku, s.name, s.description, s.category, s.color, s.material, s.price_pkr, s.score
  order by s.score desc, s.name
  limit greatest(1, least(result_limit, 10));
$$;
