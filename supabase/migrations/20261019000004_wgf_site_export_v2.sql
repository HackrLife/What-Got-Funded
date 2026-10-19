-- Site export v2: adds the newsletter summary, use of funds, company social links and article source names.
create or replace function wgf.site_export(since date default current_date - 120)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'generated_at', now(),
    'rounds', coalesce(jsonb_agg(x order by x->>'announced_on' desc, (x->>'amount_usd')::numeric desc nulls last), '[]'::jsonb)
  )
  from (
    select jsonb_build_object(
      'id', r.id,
      'company_id', c.id,
      'company', coalesce(c.name_en, c.name),
      'company_native', c.name_native,
      'domain', c.domain,
      'description', c.description,
      'hq_city', c.hq_city,
      'hq_country', c.hq_country,
      'sector', c.sector,
      'linkedin_url', c.linkedin_url,
      'x_url', c.x_url,
      'careers_url', c.careers_url,
      'stage', r.stage,
      'amount', r.amount,
      'currency', r.currency,
      'amount_usd', r.amount_usd,
      'amount_text', r.amount_text,
      'highlight', r.highlight,
      'summary', r.summary,
      'use_of_funds', (select rp.profile->>'use_of_funds' from wgf.round_profiles rp where rp.round_id = r.id),
      'instagram_url', c.instagram_url,
      'youtube_url', c.youtube_url,
      'github_url', c.github_url,
      'headline', r.headline,
      'announced_on', r.announced_on,
      'edition', r.edition,
      'leads', coalesce((select jsonb_agg(i.name order by i.name) from wgf.round_investors ri join wgf.investors i on i.id = ri.investor_id
                          where ri.round_id = r.id and ri.is_lead), '[]'::jsonb),
      'investors', coalesce((select jsonb_agg(i.name order by i.name) from wgf.round_investors ri join wgf.investors i on i.id = ri.investor_id
                              where ri.round_id = r.id and not ri.is_lead), '[]'::jsonb),
      'founders', coalesce((select jsonb_agg(jsonb_build_object('name', p.name, 'role', cp.role, 'linkedin_url', p.linkedin_url,
                                                                'x_url', p.x_url, 'verified', p.verified_by is not null))
                             from wgf.company_people cp join wgf.people p on p.id = cp.person_id where cp.company_id = c.id), '[]'::jsonb),
      'sources', coalesce((select jsonb_agg(jsonb_build_object('url', rs.url, 'title', ri.title, 'source', coalesce(s.source, ri.meta->>'source'),
                                                               'market', coalesce(s.market, ri.meta->>'market'), 'language', coalesce(s.language, ri.meta->>'source_language'), 'published_at', rs.published_at)
                                            order by rs.published_at)
                            from wgf.round_sources rs join wgf.raw_items ri on ri.id = rs.raw_item_id
                            left join wgf.sources s on s.id = ri.source_id where rs.round_id = r.id), '[]'::jsonb)
    ) x
    from wgf.rounds r join wgf.companies c on c.id = r.company_id
    where r.status = 'live' and r.announced_on >= since
  ) t
$$;

