-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — operations (Phase 3)
--
-- Everything a marching organization actually *runs on* between the
-- announcement and the awards ceremony:
--
--   events + targeting      who the thing is for (whole org, or groups)
--   RSVPs                   yes / no / maybe, with parent-on-behalf-of
--   attendance              present / absent / late / excused / left early
--   itineraries             the minute-by-minute competition-day timeline
--   packing lists           templates, per-member checkoff
--   signups                 slots, capacity, automatic waitlist
--   tasks                   assigned to members or whole groups
--   polls                   single/multi, anonymous, staged result visibility
--
-- Plus the columns that make Cadence Ensemble different from every generic
-- team app: an event may point at a REAL competition in public Cadence
-- (public_app_key / public_event_key / public_event_date), so the private
-- calendar entry and the public scoring dataset are the same show. The
-- browser resolves those keys against the static datasets under
-- docs/<app>/data/ — see docs/ensemble/ops.js.
--
-- ─── Owner: run this once in the Supabase SQL editor, after 0005. ───
-- Depends on: 0001 (touch_updated_at), 0005 (organizations, org_members,
--             org_roles, org_groups, org_group_members, org_seasons,
--             is_org_member, org_has_perm, org_can_write, org_writable,
--             org_member_id, is_group_member).
--
-- Permission vocabulary used here (declared in 0005):
--   event.create  event.edit  attendance.view  attendance.edit
--   signup.manage task.manage poll.manage      org.admin
--
-- A note on GRANTs: policy expressions are evaluated with the calling role's
-- privileges, so every helper a policy touches must stay EXECUTE-able by
-- `authenticated`. We therefore revoke from `anon` (and from PUBLIC where the
-- function is only reached through a policy) and grant explicitly to
-- `authenticated` — never a blanket `revoke ... from public` on a helper a
-- policy depends on.
-- ═══════════════════════════════════════════════════════════════════════


-- ═══ 0. org_guardians ═══════════════════════════════════════════════════
-- The guardian ⇄ student link. This table is *shared* with the members/admin
-- migration; whichever file runs first creates it. Created here with
-- `create table if not exists` and policies guarded by a catalog lookup so
-- running both files in either order is safe.
--
-- ⚠ If the members/admin migration also defines org_guardians, keep ONE
--   definition (they must agree on: guardian_member_id, member_id, org_id,
--   primary key (guardian_member_id, member_id)).

create table if not exists public.org_guardians (
  guardian_member_id uuid not null references public.org_members(id) on delete cascade,
  member_id          uuid not null references public.org_members(id) on delete cascade,
  org_id             uuid not null references public.organizations(id) on delete cascade,
  created_at         timestamptz not null default now(),
  primary key (guardian_member_id, member_id)
);
create index if not exists org_guardians_member_idx on public.org_guardians (member_id);
create index if not exists org_guardians_org_idx    on public.org_guardians (org_id);

alter table public.org_guardians enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'org_guardians'
                    and policyname = 'guardians_read') then
    execute 'create policy guardians_read on public.org_guardians
               for select to authenticated using (public.is_org_member(org_id))';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'org_guardians'
                    and policyname = 'guardians_write') then
    execute 'create policy guardians_write on public.org_guardians
               for all to authenticated
               using (public.org_can_write(org_id, ''member.manage''))
               with check (public.org_can_write(org_id, ''member.manage''))';
  end if;
end $$;


-- ═══ 1. events ══════════════════════════════════════════════════════════

create table public.org_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  season_id uuid references public.org_seasons(id) on delete set null,
  title text not null,
  kind text not null default 'rehearsal'
    check (kind in ('rehearsal', 'competition', 'performance', 'game', 'camp',
                    'meeting', 'fundraiser', 'travel', 'sectional', 'audition',
                    'other')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  location text,
  address text,
  description text,
  attachments jsonb not null default '[]'::jsonb,   -- [{name,path,size,mime}]
  rsvp_required boolean not null default false,
  attendance_required boolean not null default false,
  -- ── the public↔private bridge ────────────────────────────────────────
  -- Points at a real competition in public Cadence. public_app_key matches
  -- organizations.public_app_key ('' = DCI, 'boa', 'wgi/guard', 'uil', …);
  -- public_event_key is the slug of that show's name in the app's dataset;
  -- public_event_date is its date, which selects seasons/<year>.json.
  public_app_key text,
  public_event_key text,
  public_event_date date,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
create index org_events_org_idx on public.org_events (org_id, starts_at);
create index org_events_season_idx on public.org_events (season_id);
create index org_events_public_idx on public.org_events (public_app_key, public_event_key);

create trigger org_events_touch before update on public.org_events
  for each row execute function public.touch_updated_at();

-- who the event is for. No rows at all = the whole organization.
create table public.org_event_targets (
  event_id uuid not null references public.org_events(id) on delete cascade,
  group_id uuid not null references public.org_groups(id) on delete cascade,
  primary key (event_id, group_id)
);
create index org_event_targets_group_idx on public.org_event_targets (group_id);

create table public.org_event_rsvps (
  event_id uuid not null references public.org_events(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  response text not null check (response in ('yes', 'no', 'maybe')),
  note text,
  responded_by_user uuid references auth.users(id) on delete set null,
  responded_at timestamptz not null default now(),
  primary key (event_id, member_id)
);
create index org_event_rsvps_member_idx on public.org_event_rsvps (member_id);

create table public.org_attendance (
  event_id uuid not null references public.org_events(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  status text not null
    check (status in ('present', 'absent', 'late', 'excused', 'left_early')),
  note text,
  recorded_by_member uuid references public.org_members(id) on delete set null,
  recorded_at timestamptz not null default now(),
  primary key (event_id, member_id)
);
create index org_attendance_member_idx on public.org_attendance (member_id);


-- ═══ 2. itineraries — the competition-day timeline ══════════════════════

create table public.org_itineraries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references public.org_events(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.org_itinerary_items (
  id uuid primary key default gen_random_uuid(),
  itinerary_id uuid not null references public.org_itineraries(id) on delete cascade,
  at_time timestamptz not null,
  title text not null,
  detail text,
  -- optional: this line only applies to one group (Battery loads at 5:40…)
  group_id uuid references public.org_groups(id) on delete set null,
  sort int not null default 0
);
create index org_itinerary_items_it_idx on public.org_itinerary_items (itinerary_id, at_time, sort);


-- ═══ 3. packing lists ═══════════════════════════════════════════════════

create table public.org_packing_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid references public.org_events(id) on delete cascade,  -- null = org template
  name text not null,
  is_template boolean not null default false,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index org_packing_lists_org_idx on public.org_packing_lists (org_id);
create index org_packing_lists_event_idx on public.org_packing_lists (event_id);

create table public.org_packing_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.org_packing_lists(id) on delete cascade,
  label text not null,
  group_id uuid references public.org_groups(id) on delete set null,  -- e.g. guard only
  sort int not null default 0
);
create index org_packing_items_list_idx on public.org_packing_items (list_id, sort);

create table public.org_packing_checks (
  item_id uuid not null references public.org_packing_items(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  checked_at timestamptz not null default now(),
  primary key (item_id, member_id)
);
create index org_packing_checks_member_idx on public.org_packing_checks (member_id);


-- ═══ 4. signups (volunteer slots, chaperones, pit crew, meal shifts) ════

create table public.org_signups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid references public.org_events(id) on delete cascade,
  title text not null,
  description text,
  closes_at timestamptz,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index org_signups_org_idx on public.org_signups (org_id);
create index org_signups_event_idx on public.org_signups (event_id);

create table public.org_signup_slots (
  id uuid primary key default gen_random_uuid(),
  signup_id uuid not null references public.org_signups(id) on delete cascade,
  label text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  capacity int not null default 1 check (capacity >= 0),  -- 0 = unlimited
  notes text,
  sort int not null default 0
);
create index org_signup_slots_signup_idx on public.org_signup_slots (signup_id, sort);

create table public.org_signup_claims (
  slot_id uuid not null references public.org_signup_slots(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  note text,
  waitlisted boolean not null default false,   -- claimed past capacity
  claimed_at timestamptz not null default now(),
  primary key (slot_id, member_id)
);
create index org_signup_claims_member_idx on public.org_signup_claims (member_id);
create index org_signup_claims_wait_idx on public.org_signup_claims (slot_id, waitlisted, claimed_at);


-- ═══ 5. tasks ═══════════════════════════════════════════════════════════

create table public.org_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  detail text,
  due_on date,
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high')),
  status text not null default 'open'
    check (status in ('open', 'doing', 'done')),
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index org_tasks_org_idx on public.org_tasks (org_id, status, due_on);

create trigger org_tasks_touch before update on public.org_tasks
  for each row execute function public.touch_updated_at();

create table public.org_task_assignees (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.org_tasks(id) on delete cascade,
  member_id uuid references public.org_members(id) on delete cascade,
  group_id uuid references public.org_groups(id) on delete cascade,
  check (num_nonnulls(member_id, group_id) = 1)
);
create unique index org_task_assignees_member_uq on public.org_task_assignees (task_id, member_id)
  where member_id is not null;
create unique index org_task_assignees_group_uq on public.org_task_assignees (task_id, group_id)
  where group_id is not null;


-- ═══ 6. polls ═══════════════════════════════════════════════════════════

create table public.org_polls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  question text not null,
  kind text not null default 'single' check (kind in ('single', 'multi')),
  anonymous boolean not null default false,
  closes_at timestamptz,
  results_visible text not null default 'always'
    check (results_visible in ('always', 'after_close', 'staff')),
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index org_polls_org_idx on public.org_polls (org_id, created_at desc);

create table public.org_poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.org_polls(id) on delete cascade,
  label text not null,
  sort int not null default 0
);
create index org_poll_options_poll_idx on public.org_poll_options (poll_id, sort);

create table public.org_poll_votes (
  poll_id uuid not null references public.org_polls(id) on delete cascade,
  option_id uuid not null references public.org_poll_options(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (option_id, member_id)
);
create index org_poll_votes_poll_idx on public.org_poll_votes (poll_id, member_id);


-- ═══════════════════════════════════════════════════════════════════════
-- HELPERS — SECURITY DEFINER so policies can look past RLS without
-- recursing. Every one pins search_path.
-- ═══════════════════════════════════════════════════════════════════════

-- the org an event belongs to (null if the event is gone)
create or replace function public.event_org(p_event uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select e.org_id from public.org_events e where e.id = p_event
$$;

-- ── THE targeting rule, in one place. Reused by every child table so
--    "who can see this event" is defined exactly once.
--    Visible when: I'm an active member of the org AND
--      (the event has no group targets  — it's for everyone), OR
--      (I'm in one of the targeted groups), OR
--      (I'm staff who can edit events / an admin — staff see everything).
create or replace function public.can_see_event(p_event uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
      from public.org_events e
     where e.id = p_event
       and public.is_org_member(e.org_id)
       and (
         not exists (select 1 from public.org_event_targets t where t.event_id = e.id)
         or exists (
              select 1
                from public.org_event_targets t
                join public.org_group_members gm on gm.group_id = t.group_id
                join public.org_members m on m.id = gm.member_id
               where t.event_id = e.id
                 and m.user_id = auth.uid()
                 and m.status = 'active')
         or public.org_has_perm(e.org_id, 'event.edit')
         or public.org_has_perm(e.org_id, 'attendance.view')
       )
  )
$$;

-- may I change this event and its children (itinerary, packing, targets)?
-- event.edit anywhere in the org, or event.create on an event I made.
create or replace function public.can_manage_event(p_event uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_events e
     where e.id = p_event
       and (public.org_can_write(e.org_id, 'event.edit')
            or (public.org_can_write(e.org_id, 'event.create')
                and e.created_by_member is not distinct from public.org_member_id(e.org_id)))
  )
$$;

-- am I this member, or their guardian? Guardians must hold a role whose kind
-- is 'parent' — a link alone is not enough.
create or replace function public.org_acts_for_member(p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_members m
     where m.id = p_member and m.user_id = auth.uid() and m.status = 'active'
  ) or exists (
    select 1
      from public.org_guardians g
      join public.org_members gm on gm.id = g.guardian_member_id
      join public.org_roles r on r.id = gm.role_id
     where g.member_id = p_member
       and gm.user_id = auth.uid()
       and gm.status = 'active'
       and r.kind = 'parent'
  )
$$;

-- packing lists / signups may hang off an event or off the org itself
create or replace function public.can_see_packing_list(p_list uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_packing_lists l
     where l.id = p_list
       and public.is_org_member(l.org_id)
       and (l.event_id is null or public.can_see_event(l.event_id))
  )
$$;

create or replace function public.can_manage_packing_list(p_list uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_packing_lists l
     where l.id = p_list
       and (public.org_can_write(l.org_id, 'event.edit')
            or public.org_can_write(l.org_id, 'event.create'))
  )
$$;

create or replace function public.can_see_signup(p_signup uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_signups s
     where s.id = p_signup
       and public.is_org_member(s.org_id)
       and (s.event_id is null or public.can_see_event(s.event_id))
  )
$$;

create or replace function public.signup_org(p_signup uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select s.org_id from public.org_signups s where s.id = p_signup
$$;

create or replace function public.slot_signup(p_slot uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select l.signup_id from public.org_signup_slots l where l.id = p_slot
$$;

-- assigned to me directly, or to a group I'm in
create or replace function public.is_task_assignee(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
      from public.org_task_assignees a
      left join public.org_members m on m.id = a.member_id
      left join public.org_group_members gm on gm.group_id = a.group_id
      left join public.org_members gmm on gmm.id = gm.member_id
     where a.task_id = p_task
       and ((m.user_id = auth.uid() and m.status = 'active')
            or (gmm.user_id = auth.uid() and gmm.status = 'active'))
  )
$$;

-- may I see the tally for this poll? (own votes are always visible)
create or replace function public.poll_results_visible(p_poll uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_polls p
     where p.id = p_poll
       and public.is_org_member(p.org_id)
       and (public.org_has_perm(p.org_id, 'poll.manage')
            or p.results_visible = 'always'
            or (p.results_visible = 'after_close'
                and p.closes_at is not null and p.closes_at <= now()))
  )
$$;

revoke execute on function public.event_org(uuid) from anon;
revoke execute on function public.can_see_event(uuid) from anon;
revoke execute on function public.can_manage_event(uuid) from anon;
revoke execute on function public.org_acts_for_member(uuid) from anon;
revoke execute on function public.can_see_packing_list(uuid) from anon;
revoke execute on function public.can_manage_packing_list(uuid) from anon;
revoke execute on function public.can_see_signup(uuid) from anon;
revoke execute on function public.signup_org(uuid) from anon;
revoke execute on function public.slot_signup(uuid) from anon;
revoke execute on function public.is_task_assignee(uuid) from anon;
revoke execute on function public.poll_results_visible(uuid) from anon;

grant execute on function public.event_org(uuid) to authenticated;
grant execute on function public.can_see_event(uuid) to authenticated;
grant execute on function public.can_manage_event(uuid) to authenticated;
grant execute on function public.org_acts_for_member(uuid) to authenticated;
grant execute on function public.can_see_packing_list(uuid) to authenticated;
grant execute on function public.can_manage_packing_list(uuid) to authenticated;
grant execute on function public.can_see_signup(uuid) to authenticated;
grant execute on function public.signup_org(uuid) to authenticated;
grant execute on function public.slot_signup(uuid) to authenticated;
grant execute on function public.is_task_assignee(uuid) to authenticated;
grant execute on function public.poll_results_visible(uuid) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- RLS
--
--   READ   membership in the org, plus the targeting rule (can_see_event)
--          wherever an event is involved.
--   WRITE  org_can_write(org, perm) — which folds in permission AND an
--          unexpired subscription, so a read-only workspace keeps all of
--          its history but stops accepting new rows.
--   SELF   a member may always write their own RSVP, packing checks,
--          signup claims and poll votes; their own attendance *note* goes
--          through an RPC so they cannot mark themselves present.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.org_events          enable row level security;
alter table public.org_event_targets   enable row level security;
alter table public.org_event_rsvps     enable row level security;
alter table public.org_attendance      enable row level security;
alter table public.org_itineraries     enable row level security;
alter table public.org_itinerary_items enable row level security;
alter table public.org_packing_lists   enable row level security;
alter table public.org_packing_items   enable row level security;
alter table public.org_packing_checks  enable row level security;
alter table public.org_signups         enable row level security;
alter table public.org_signup_slots    enable row level security;
alter table public.org_signup_claims   enable row level security;
alter table public.org_tasks           enable row level security;
alter table public.org_task_assignees  enable row level security;
alter table public.org_polls           enable row level security;
alter table public.org_poll_options    enable row level security;
alter table public.org_poll_votes      enable row level security;

-- ── events
create policy events_read on public.org_events for select to authenticated
  using (public.can_see_event(id));
create policy events_insert on public.org_events for insert to authenticated
  with check (public.org_can_write(org_id, 'event.create'));
create policy events_update on public.org_events for update to authenticated
  using (public.can_manage_event(id))
  with check (public.org_can_write(org_id, 'event.create')
              or public.org_can_write(org_id, 'event.edit'));
create policy events_delete on public.org_events for delete to authenticated
  using (public.can_manage_event(id));

create policy event_targets_read on public.org_event_targets for select to authenticated
  using (public.can_see_event(event_id));
create policy event_targets_write on public.org_event_targets for all to authenticated
  using (public.can_manage_event(event_id))
  with check (public.can_manage_event(event_id));

-- ── RSVPs: everyone who can see the event sees the counts; you write your
--    own row, a parent writes their student's, staff may fix any of them.
create policy rsvps_read on public.org_event_rsvps for select to authenticated
  using (public.can_see_event(event_id));
create policy rsvps_self_write on public.org_event_rsvps for all to authenticated
  using (public.org_acts_for_member(member_id)
         and public.can_see_event(event_id)
         and public.org_writable(public.event_org(event_id)))
  with check (public.org_acts_for_member(member_id)
              and public.can_see_event(event_id)
              and public.org_writable(public.event_org(event_id)));
create policy rsvps_staff_write on public.org_event_rsvps for all to authenticated
  using (public.can_manage_event(event_id))
  with check (public.can_manage_event(event_id));

-- ── attendance: a student's record is not peer-visible. Staff with
--    attendance.view/edit see the grid; you and your guardian see yours.
create policy attendance_read on public.org_attendance for select to authenticated
  using (public.can_see_event(event_id)
         and (public.org_has_perm(public.event_org(event_id), 'attendance.view')
              or public.org_has_perm(public.event_org(event_id), 'attendance.edit')
              or public.org_acts_for_member(member_id)));
create policy attendance_write on public.org_attendance for all to authenticated
  using (public.org_can_write(public.event_org(event_id), 'attendance.edit'))
  with check (public.org_can_write(public.event_org(event_id), 'attendance.edit'));

-- ── itineraries
create policy itin_read on public.org_itineraries for select to authenticated
  using (public.can_see_event(event_id));
create policy itin_write on public.org_itineraries for all to authenticated
  using (public.can_manage_event(event_id))
  with check (public.can_manage_event(event_id));

create policy itin_items_read on public.org_itinerary_items for select to authenticated
  using (exists (select 1 from public.org_itineraries i
                  where i.id = itinerary_id and public.can_see_event(i.event_id)));
create policy itin_items_write on public.org_itinerary_items for all to authenticated
  using (exists (select 1 from public.org_itineraries i
                  where i.id = itinerary_id and public.can_manage_event(i.event_id)))
  with check (exists (select 1 from public.org_itineraries i
                  where i.id = itinerary_id and public.can_manage_event(i.event_id)));

-- ── packing lists
create policy packlist_read on public.org_packing_lists for select to authenticated
  using (public.is_org_member(org_id)
         and (event_id is null or public.can_see_event(event_id)));
create policy packlist_write on public.org_packing_lists for all to authenticated
  using (public.org_can_write(org_id, 'event.edit') or public.org_can_write(org_id, 'event.create'))
  with check (public.org_can_write(org_id, 'event.edit') or public.org_can_write(org_id, 'event.create'));

create policy packitem_read on public.org_packing_items for select to authenticated
  using (public.can_see_packing_list(list_id));
create policy packitem_write on public.org_packing_items for all to authenticated
  using (public.can_manage_packing_list(list_id))
  with check (public.can_manage_packing_list(list_id));

-- your own checkboxes; staff may see everyone's to chase down the missing
create policy packcheck_read on public.org_packing_checks for select to authenticated
  using (exists (select 1 from public.org_packing_items pi
                  where pi.id = item_id and public.can_see_packing_list(pi.list_id)));
create policy packcheck_self on public.org_packing_checks for all to authenticated
  using (public.org_acts_for_member(member_id)
         and exists (select 1 from public.org_packing_items pi
                      where pi.id = item_id and public.can_see_packing_list(pi.list_id)))
  with check (public.org_acts_for_member(member_id)
         and exists (select 1 from public.org_packing_items pi
                      where pi.id = item_id and public.can_see_packing_list(pi.list_id)));

-- ── signups
create policy signup_read on public.org_signups for select to authenticated
  using (public.is_org_member(org_id)
         and (event_id is null or public.can_see_event(event_id)));
create policy signup_write on public.org_signups for all to authenticated
  using (public.org_can_write(org_id, 'signup.manage'))
  with check (public.org_can_write(org_id, 'signup.manage'));

create policy signup_slot_read on public.org_signup_slots for select to authenticated
  using (public.can_see_signup(signup_id));
create policy signup_slot_write on public.org_signup_slots for all to authenticated
  using (public.org_can_write(public.signup_org(signup_id), 'signup.manage'))
  with check (public.org_can_write(public.signup_org(signup_id), 'signup.manage'));

create policy signup_claim_read on public.org_signup_claims for select to authenticated
  using (public.can_see_signup(public.slot_signup(slot_id)));
create policy signup_claim_self on public.org_signup_claims for all to authenticated
  using (public.org_acts_for_member(member_id)
         and public.can_see_signup(public.slot_signup(slot_id))
         and public.org_writable(public.signup_org(public.slot_signup(slot_id))))
  with check (public.org_acts_for_member(member_id)
         and public.can_see_signup(public.slot_signup(slot_id))
         and public.org_writable(public.signup_org(public.slot_signup(slot_id))));
create policy signup_claim_staff on public.org_signup_claims for all to authenticated
  using (public.org_can_write(public.signup_org(public.slot_signup(slot_id)), 'signup.manage'))
  with check (public.org_can_write(public.signup_org(public.slot_signup(slot_id)), 'signup.manage'));

-- ── tasks: readable org-wide; managed by task.manage; assignees may move
--    their own task along the board (the UPDATE check keeps them in-org).
create policy task_read on public.org_tasks for select to authenticated
  using (public.is_org_member(org_id));
create policy task_write on public.org_tasks for all to authenticated
  using (public.org_can_write(org_id, 'task.manage'))
  with check (public.org_can_write(org_id, 'task.manage'));
create policy task_assignee_update on public.org_tasks for update to authenticated
  using (public.is_task_assignee(id) and public.org_writable(org_id))
  with check (public.is_task_assignee(id) and public.org_writable(org_id));

create policy task_assignee_read on public.org_task_assignees for select to authenticated
  using (exists (select 1 from public.org_tasks t
                  where t.id = task_id and public.is_org_member(t.org_id)));
create policy task_assignee_write on public.org_task_assignees for all to authenticated
  using (exists (select 1 from public.org_tasks t
                  where t.id = task_id and public.org_can_write(t.org_id, 'task.manage')))
  with check (exists (select 1 from public.org_tasks t
                  where t.id = task_id and public.org_can_write(t.org_id, 'task.manage')));

-- ── polls
create policy poll_read on public.org_polls for select to authenticated
  using (public.is_org_member(org_id));
create policy poll_write on public.org_polls for all to authenticated
  using (public.org_can_write(org_id, 'poll.manage'))
  with check (public.org_can_write(org_id, 'poll.manage'));

create policy poll_option_read on public.org_poll_options for select to authenticated
  using (exists (select 1 from public.org_polls p
                  where p.id = poll_id and public.is_org_member(p.org_id)));
create policy poll_option_write on public.org_poll_options for all to authenticated
  using (exists (select 1 from public.org_polls p
                  where p.id = poll_id and public.org_can_write(p.org_id, 'poll.manage')))
  with check (exists (select 1 from public.org_polls p
                  where p.id = poll_id and public.org_can_write(p.org_id, 'poll.manage')));

-- votes: always your own. Other people's rows only when the poll is not
-- anonymous AND results are visible to you. Anonymous tallies come from
-- org_poll_results() instead, which never returns who voted for what.
create policy poll_vote_read on public.org_poll_votes for select to authenticated
  using (
    public.org_acts_for_member(member_id)
    or (public.poll_results_visible(poll_id)
        and exists (select 1 from public.org_polls p
                     where p.id = poll_id and not p.anonymous))
  );
create policy poll_vote_self on public.org_poll_votes for all to authenticated
  using (public.org_acts_for_member(member_id)
         and exists (select 1 from public.org_polls p
                      where p.id = poll_id and public.org_writable(p.org_id)))
  with check (public.org_acts_for_member(member_id)
         and exists (select 1 from public.org_polls p
                      where p.id = poll_id and public.org_writable(p.org_id)
                        and (p.closes_at is null or p.closes_at > now())));
create policy poll_vote_staff on public.org_poll_votes for delete to authenticated
  using (exists (select 1 from public.org_polls p
                  where p.id = poll_id and public.org_can_write(p.org_id, 'poll.manage')));


-- ═══════════════════════════════════════════════════════════════════════
-- RPCs — the operations that must be atomic or must not be expressible as
-- a plain table write from the browser.
-- ═══════════════════════════════════════════════════════════════════════

-- ── RSVP (mine, or my student's). One call, no client-side member lookup.
create or replace function public.org_rsvp_set(
  p_event uuid, p_response text, p_member uuid default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_member uuid;
begin
  select org_id into v_org from public.org_events where id = p_event;
  if v_org is null then raise exception 'event_not_found'; end if;
  if not public.can_see_event(p_event) then raise exception 'not_permitted'; end if;
  if not public.org_writable(v_org) then raise exception 'workspace_read_only'; end if;
  v_member := coalesce(p_member, public.org_member_id(v_org));
  if v_member is null then raise exception 'not_a_member'; end if;
  if not public.org_acts_for_member(v_member) then raise exception 'not_permitted'; end if;
  if p_response not in ('yes', 'no', 'maybe') then raise exception 'bad_response'; end if;

  insert into public.org_event_rsvps (event_id, member_id, response, note, responded_by_user, responded_at)
  values (p_event, v_member, p_response, p_note, auth.uid(), now())
  on conflict (event_id, member_id) do update
    set response = excluded.response, note = excluded.note,
        responded_by_user = excluded.responded_by_user, responded_at = now();
end $$;

-- ── attendance: the whole grid in one request. Rows are
--    [{"member_id":"…","status":"present","note":null}, …]
create or replace function public.org_attendance_save(p_event uuid, p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_by uuid;
  v_n int := 0;
begin
  select org_id into v_org from public.org_events where id = p_event;
  if v_org is null then raise exception 'event_not_found'; end if;
  if not public.org_can_write(v_org, 'attendance.edit') then raise exception 'not_permitted'; end if;
  v_by := public.org_member_id(v_org);

  insert into public.org_attendance (event_id, member_id, status, note, recorded_by_member, recorded_at)
  select p_event,
         (r->>'member_id')::uuid,
         r->>'status',
         nullif(r->>'note', ''),
         v_by,
         now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
   where r->>'status' in ('present', 'absent', 'late', 'excused', 'left_early')
     and exists (select 1 from public.org_members m
                  where m.id = (r->>'member_id')::uuid and m.org_id = v_org)
  on conflict (event_id, member_id) do update
    set status = excluded.status,
        note = coalesce(excluded.note, org_attendance.note),
        recorded_by_member = excluded.recorded_by_member,
        recorded_at = now();

  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ── a member (or their guardian) explaining an absence. Touches the note
--    only — never the status, which is why this isn't a table policy.
create or replace function public.org_attendance_self_note(
  p_event uuid, p_note text, p_member uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_member uuid;
begin
  select org_id into v_org from public.org_events where id = p_event;
  if v_org is null then raise exception 'event_not_found'; end if;
  if not public.org_writable(v_org) then raise exception 'workspace_read_only'; end if;
  v_member := coalesce(p_member, public.org_member_id(v_org));
  if v_member is null or not public.org_acts_for_member(v_member) then
    raise exception 'not_permitted';
  end if;

  -- If staff have already marked this member, only the note changes. If they
  -- haven't, the row starts as 'absent' — a member cannot excuse themselves;
  -- staff move it to 'excused' once they accept the reason.
  insert into public.org_attendance (event_id, member_id, status, note)
  values (p_event, v_member, 'absent', p_note)
  on conflict (event_id, member_id) do update set note = excluded.note;
end $$;

-- ── claiming a signup slot: capacity and waitlist decided server-side, so
--    two parents tapping at once can't both take the last chaperone spot.
--    Returns true when confirmed, false when waitlisted.
create or replace function public.org_signup_claim(p_slot uuid, p_note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_signup uuid;
  v_org uuid;
  v_member uuid;
  v_cap int;
  v_taken int;
  v_wait boolean;
  v_closes timestamptz;
begin
  select s.id, s.org_id, s.closes_at, sl.capacity
    into v_signup, v_org, v_closes, v_cap
    from public.org_signup_slots sl
    join public.org_signups s on s.id = sl.signup_id
   where sl.id = p_slot
   for update of sl;
  if v_signup is null then raise exception 'slot_not_found'; end if;
  if not public.can_see_signup(v_signup) then raise exception 'not_permitted'; end if;
  if not public.org_writable(v_org) then raise exception 'workspace_read_only'; end if;
  if v_closes is not null and v_closes <= now() then raise exception 'signup_closed'; end if;

  v_member := public.org_member_id(v_org);
  if v_member is null then raise exception 'not_a_member'; end if;

  if exists (select 1 from public.org_signup_claims
              where slot_id = p_slot and member_id = v_member) then
    return not (select waitlisted from public.org_signup_claims
                 where slot_id = p_slot and member_id = v_member);
  end if;

  select count(*) into v_taken from public.org_signup_claims
   where slot_id = p_slot and not waitlisted;
  v_wait := (v_cap > 0 and v_taken >= v_cap);

  insert into public.org_signup_claims (slot_id, member_id, note, waitlisted)
  values (p_slot, v_member, p_note, v_wait);
  return not v_wait;
end $$;

-- ── releasing a slot promotes the first person off the waitlist
create or replace function public.org_signup_release(p_slot uuid, p_member uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_signup uuid;
  v_org uuid;
  v_member uuid;
  v_cap int;
  v_taken int;
  v_next uuid;
begin
  select s.id, s.org_id, sl.capacity into v_signup, v_org, v_cap
    from public.org_signup_slots sl
    join public.org_signups s on s.id = sl.signup_id
   where sl.id = p_slot
   for update of sl;
  if v_signup is null then raise exception 'slot_not_found'; end if;

  v_member := coalesce(p_member, public.org_member_id(v_org));
  if not (public.org_acts_for_member(v_member)
          or public.org_can_write(v_org, 'signup.manage')) then
    raise exception 'not_permitted';
  end if;

  delete from public.org_signup_claims where slot_id = p_slot and member_id = v_member;

  if v_cap > 0 then
    select count(*) into v_taken from public.org_signup_claims
     where slot_id = p_slot and not waitlisted;
    while v_taken < v_cap loop
      select member_id into v_next from public.org_signup_claims
       where slot_id = p_slot and waitlisted
       order by claimed_at limit 1;
      exit when v_next is null;
      update public.org_signup_claims set waitlisted = false
       where slot_id = p_slot and member_id = v_next;
      v_taken := v_taken + 1;
      v_next := null;
    end loop;
  end if;
end $$;

-- ── voting: replaces the member's whole ballot, enforces single vs multi
create or replace function public.org_poll_vote(p_poll uuid, p_options uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
  p public.org_polls%rowtype;
  v_member uuid;
begin
  select * into p from public.org_polls where id = p_poll;
  if p.id is null then raise exception 'poll_not_found'; end if;
  if not public.is_org_member(p.org_id) then raise exception 'not_permitted'; end if;
  if not public.org_writable(p.org_id) then raise exception 'workspace_read_only'; end if;
  if p.closes_at is not null and p.closes_at <= now() then raise exception 'poll_closed'; end if;
  if p.kind = 'single' and coalesce(array_length(p_options, 1), 0) > 1 then
    raise exception 'single_choice_poll';
  end if;

  v_member := public.org_member_id(p.org_id);
  if v_member is null then raise exception 'not_a_member'; end if;

  delete from public.org_poll_votes where poll_id = p_poll and member_id = v_member;
  insert into public.org_poll_votes (poll_id, option_id, member_id)
  select p_poll, o.id, v_member
    from public.org_poll_options o
   where o.poll_id = p_poll and o.id = any(coalesce(p_options, '{}'::uuid[]));
end $$;

-- ── the tally. Safe for anonymous polls: counts only, never voters.
create or replace function public.org_poll_results(p_poll uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_org uuid;
  v_out jsonb;
begin
  select org_id into v_org from public.org_polls where id = p_poll;
  if v_org is null then raise exception 'poll_not_found'; end if;
  if not public.is_org_member(v_org) then raise exception 'not_permitted'; end if;
  if not public.poll_results_visible(p_poll) then raise exception 'results_hidden'; end if;

  select jsonb_build_object(
           'total', (select count(distinct member_id) from public.org_poll_votes where poll_id = p_poll),
           'options', coalesce(jsonb_agg(jsonb_build_object(
                        'id', o.id, 'label', o.label, 'votes', c.n) order by o.sort, o.label), '[]'::jsonb))
    into v_out
    from public.org_poll_options o
    left join lateral (
      select count(*)::int as n from public.org_poll_votes v where v.option_id = o.id
    ) c on true
   where o.poll_id = p_poll;
  return v_out;
end $$;

-- ── one-call event creation with its targets, so a half-created event can
--    never exist if the targets insert fails.
create or replace function public.org_event_create(p_event jsonb, p_groups uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := (p_event->>'org_id')::uuid;
  v_id uuid;
begin
  if v_org is null then raise exception 'org_required'; end if;
  if not public.org_can_write(v_org, 'event.create') then raise exception 'not_permitted'; end if;

  insert into public.org_events (
    org_id, season_id, title, kind, starts_at, ends_at, all_day, location, address,
    description, attachments, rsvp_required, attendance_required,
    public_app_key, public_event_key, public_event_date, created_by_member)
  values (
    v_org,
    nullif(p_event->>'season_id', '')::uuid,
    coalesce(nullif(p_event->>'title', ''), 'Untitled event'),
    coalesce(nullif(p_event->>'kind', ''), 'rehearsal'),
    (p_event->>'starts_at')::timestamptz,
    nullif(p_event->>'ends_at', '')::timestamptz,
    coalesce((p_event->>'all_day')::boolean, false),
    nullif(p_event->>'location', ''),
    nullif(p_event->>'address', ''),
    nullif(p_event->>'description', ''),
    coalesce(p_event->'attachments', '[]'::jsonb),
    coalesce((p_event->>'rsvp_required')::boolean, false),
    coalesce((p_event->>'attendance_required')::boolean, false),
    p_event->>'public_app_key',
    nullif(p_event->>'public_event_key', ''),
    nullif(p_event->>'public_event_date', '')::date,
    public.org_member_id(v_org))
  returning id into v_id;

  insert into public.org_event_targets (event_id, group_id)
  select v_id, g.id from public.org_groups g
   where g.org_id = v_org and g.id = any(coalesce(p_groups, '{}'::uuid[]))
  on conflict do nothing;

  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (v_org, auth.uid(), 'event.created', 'event', v_id::text);
  return v_id;
end $$;

revoke execute on function public.org_rsvp_set(uuid, text, uuid, text) from public, anon;
revoke execute on function public.org_attendance_save(uuid, jsonb) from public, anon;
revoke execute on function public.org_attendance_self_note(uuid, text, uuid) from public, anon;
revoke execute on function public.org_signup_claim(uuid, text) from public, anon;
revoke execute on function public.org_signup_release(uuid, uuid) from public, anon;
revoke execute on function public.org_poll_vote(uuid, uuid[]) from public, anon;
revoke execute on function public.org_poll_results(uuid) from public, anon;
revoke execute on function public.org_event_create(jsonb, uuid[]) from public, anon;

grant execute on function public.org_rsvp_set(uuid, text, uuid, text) to authenticated;
grant execute on function public.org_attendance_save(uuid, jsonb) to authenticated;
grant execute on function public.org_attendance_self_note(uuid, text, uuid) to authenticated;
grant execute on function public.org_signup_claim(uuid, text) to authenticated;
grant execute on function public.org_signup_release(uuid, uuid) to authenticated;
grant execute on function public.org_poll_vote(uuid, uuid[]) to authenticated;
grant execute on function public.org_poll_results(uuid) to authenticated;
grant execute on function public.org_event_create(jsonb, uuid[]) to authenticated;


-- ═══ Owner workflow queries ════════════════════════════════════════════
-- Link an organization to its public Cadence identity (turns on the
-- competition bridge in docs/ensemble/ops.js):
--   update organizations
--      set public_app_key = 'boa', public_ensemble_name = 'Carmel HS (IN)'
--    where slug = '…';
--   -- public_app_key '' means the DCI app at the site root.
--
-- Events whose competition result should now be resolvable:
--   select title, public_app_key, public_event_key, public_event_date
--     from org_events
--    where public_event_key is not null and public_event_date < current_date;
--
-- Attendance rate for a season:
--   select e.title, count(*) filter (where a.status = 'present')::float
--          / nullif(count(*), 0) as rate
--     from org_events e join org_attendance a on a.event_id = e.id
--    where e.org_id = '…' group by e.id, e.title order by min(e.starts_at);
