-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — drill design & dot books
--
-- The workspace learns to hold a show's drill: directors write charts in
-- the built-in designer, members open the same show and see their own dot
-- — where to stand for every set, how to get there, and at what stride.
--
-- Layout of the data:
--   drill_shows        one row per show/production, owned by an org
--   drill_performers   the dots: label ("T4"), section, look, and an
--                      optional link to the org member marching it
--   drill_sets         one row per page/set; positions live in a JSONB
--                      map {performer_id: [x, y]} in 8-to-5 steps, so a
--                      whole page saves as one UPDATE instead of hundreds
--                      of dot rows
--
-- Coordinates: x in steps from the 50 (Side 1 negative), y in steps from
-- the front sideline. Indoor floors use x from center, y from the front
-- edge. The client owns the interpretation; the database just stores steps.
--
-- Access: any active org member can read a show and every dot in it (a
-- dot book is useless if you can only see yourself). Writing takes the
-- new `drill.manage` permission — seeded to staff-level roles here, and
-- implied by org.admin as always. Members claim their own dot through a
-- guarded RPC rather than open UPDATE on the performers table.
--
-- Depends on: 0001 (touch_updated_at), 0005 (organizations, org_members,
-- is_org_member, org_can_write, org_member_id, seed_new_organization).
-- ═══════════════════════════════════════════════════════════════════════

-- ── shows ──────────────────────────────────────────────────────────────
create table public.drill_shows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  field_type text not null default 'hs'
    check (field_type in ('hs', 'college', 'pro', 'indoor')),
  tempo integer not null default 120 check (tempo between 40 and 300),
  notes text not null default '',
  archived boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index drill_shows_org on public.drill_shows (org_id, archived, updated_at desc);

-- ── performers (the dots) ──────────────────────────────────────────────
create table public.drill_performers (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references public.drill_shows(id) on delete cascade,
  label text not null,                       -- the dot ID members search for
  name text not null default '',             -- optional real name / assignment
  section text not null default '',          -- Trumpets, Battery, Guard…
  symbol text not null default 'circle'
    check (symbol in ('circle', 'square', 'triangle', 'x', 'star')),
  color text not null default '#1971c2' check (color ~ '^#[0-9a-fA-F]{6}$'),
  member_id uuid references public.org_members(id) on delete set null,
  sort integer not null default 0,
  unique (show_id, label)
);
create index drill_performers_show on public.drill_performers (show_id, sort);
create index drill_performers_member on public.drill_performers (member_id);

-- ── sets (the pages) ───────────────────────────────────────────────────
create table public.drill_sets (
  id uuid primary key default gen_random_uuid(),
  show_id uuid not null references public.drill_shows(id) on delete cascade,
  idx integer not null,                      -- 0-based page order
  name text not null default '',
  counts integer not null default 16 check (counts between 0 and 512),  -- counts INTO this set
  hold integer not null default 0 check (hold between 0 and 512),
  tempo integer check (tempo between 40 and 300),  -- per-set override, null = show tempo
  notes text not null default '',
  dots jsonb not null default '{}'::jsonb,   -- {performer_id: [x, y]} in steps
  unique (show_id, idx) deferrable initially deferred  -- reordering swaps idx in one tx
);
create index drill_sets_show on public.drill_sets (show_id, idx);

create trigger drill_shows_touch before update on public.drill_shows
  for each row execute function public.touch_updated_at();

-- ── row security ───────────────────────────────────────────────────────
alter table public.drill_shows enable row level security;
alter table public.drill_performers enable row level security;
alter table public.drill_sets enable row level security;

create policy drill_shows_read on public.drill_shows
  for select using (public.is_org_member(org_id));
create policy drill_shows_write on public.drill_shows
  for all using (public.org_can_write(org_id, 'drill.manage'))
  with check (public.org_can_write(org_id, 'drill.manage'));

create policy drill_performers_read on public.drill_performers
  for select using (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.is_org_member(s.org_id)));
create policy drill_performers_write on public.drill_performers
  for all using (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.org_can_write(s.org_id, 'drill.manage')))
  with check (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.org_can_write(s.org_id, 'drill.manage')));

create policy drill_sets_read on public.drill_sets
  for select using (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.is_org_member(s.org_id)));
create policy drill_sets_write on public.drill_sets
  for all using (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.org_can_write(s.org_id, 'drill.manage')))
  with check (exists (
    select 1 from public.drill_shows s
    where s.id = show_id and public.org_can_write(s.org_id, 'drill.manage')));

-- ── "this dot is me" ───────────────────────────────────────────────────
-- Members mark their own dot without write access to the performers table.
-- The function proves membership itself, so it is safe to expose as an RPC.
create or replace function public.claim_drill_dot(p_performer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_me uuid;
begin
  select s.org_id into v_org
    from public.drill_performers p join public.drill_shows s on s.id = p.show_id
   where p.id = p_performer;
  if v_org is null then raise exception 'no such dot'; end if;
  v_me := public.org_member_id(v_org);
  if v_me is null then raise exception 'not a member of this workspace'; end if;
  -- one person, one dot per show: release anything they claimed before
  update public.drill_performers p set member_id = null
   where p.member_id = v_me
     and p.show_id = (select show_id from public.drill_performers where id = p_performer);
  update public.drill_performers set member_id = v_me where id = p_performer;
end $$;

create or replace function public.release_drill_dot(p_performer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  select s.org_id into v_org
    from public.drill_performers p join public.drill_shows s on s.id = p.show_id
   where p.id = p_performer;
  if v_org is null then return; end if;
  -- you may release your own claim; drill writers may clear anyone's
  update public.drill_performers set member_id = null
   where id = p_performer
     and (member_id = public.org_member_id(v_org)
          or public.org_can_write(v_org, 'drill.manage'));
end $$;

revoke execute on function public.claim_drill_dot(uuid) from public, anon;
revoke execute on function public.release_drill_dot(uuid) from public, anon;
grant execute on function public.claim_drill_dot(uuid) to authenticated;
grant execute on function public.release_drill_dot(uuid) to authenticated;

-- ── permission seeding ─────────────────────────────────────────────────
-- Existing orgs: staff-level roles learn drill.manage. Owner and Director
-- carry org.admin, which already implies it.
update public.org_roles
   set permissions = permissions || '{drill.manage}'
 where key in ('assistant_director', 'staff', 'instructor')
   and not ('drill.manage' = any(permissions));

-- Future orgs: extend the 0005 seed without rewriting it. Triggers fire in
-- name order, so this runs right after organizations_seed on the same row.
create or replace function public.seed_org_drill_perms()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.org_roles
     set permissions = permissions || '{drill.manage}'
   where org_id = new.id
     and key in ('assistant_director', 'staff', 'instructor')
     and not ('drill.manage' = any(permissions));
  return new;
end $$;
revoke execute on function public.seed_org_drill_perms() from public, anon, authenticated;

create trigger organizations_seed_drill after insert on public.organizations
  for each row execute function public.seed_org_drill_perms();
