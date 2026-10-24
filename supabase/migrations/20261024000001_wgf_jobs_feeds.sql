-- Jobs from bought and free feeds (Fantastic.jobs by company domain, We Work Remotely RSS by company name).
alter table wgf.company_ats add column if not exists feed_at timestamptz;   -- first time the company's domain was sent to the jobs feed
alter table wgf.jobs add column if not exists expires_on date;              -- feed roles close on this day (boards close when the role leaves the board)
alter table wgf.jobs add column if not exists via text;                     -- credit shown next to the role, e.g. 'We Work Remotely'
