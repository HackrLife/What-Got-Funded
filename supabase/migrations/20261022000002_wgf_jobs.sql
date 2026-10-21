-- Jobs at funded startups: which public hiring system each company uses, and the roles found there.
create table if not exists wgf.company_ats (
  company_id bigint primary key references wgf.companies(id),
  source text,                 -- greenhouse | lever | ashby | workable | smartrecruiters | recruitee; null = none found
  slug text,
  checked_at timestamptz not null default now(),
  fetched_at timestamptz,
  note text
);
create table if not exists wgf.jobs (
  id bigserial primary key,
  company_id bigint not null references wgf.companies(id),
  round_id bigint references wgf.rounds(id),
  source text not null,
  external_id text not null,
  title text not null,
  team text,
  function text,               -- engineering | marketing | sales | finance | product | design | devrel | operations | people | customer | other
  seniority text,              -- c_level | vp | head | director | lead | ic
  founding boolean not null default false,
  remote boolean not null default false,
  fractional boolean not null default false,
  employment_type text,
  location text,
  posted_on date,
  url text not null,
  key_role boolean not null default false,
  score numeric,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists jobs_company on wgf.jobs (company_id) where active;
