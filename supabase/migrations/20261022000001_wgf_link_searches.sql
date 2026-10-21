-- Link finder: one row per search for a missing company website, company LinkedIn/X, or founder LinkedIn/X.
create table if not exists wgf.link_searches (
  key text primary key,          -- co:dom:<company> | co:li:<company> | co:x:<company> | p:li:<person>:<company> | p:x:<person>:<company>
  query text not null,
  searched_at timestamptz not null default now(),
  found_url text,
  candidates jsonb
);
