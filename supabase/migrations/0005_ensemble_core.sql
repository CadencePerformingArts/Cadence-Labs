-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — core foundation (Phase 1)
--
-- The private side of Cadence: organization workspaces, memberships,
-- configurable roles, granular permissions, groups, invites, access
-- requests, seasons, audit log, and the subscription/entitlement fields
-- that gate everything.
--
-- Everything private lives behind RLS keyed on organization membership.
-- Public Cadence (scores/rankings/profiles) is untouched by this file.
--
-- ─── Owner: run this once in the Supabase SQL editor. ───
-- Depends on: 0001 (profiles, touch_updated_at), 0004 (ensemble_profiles).
-- ═══════════════════════════════════════════════════════════════════════

-- ── umbrella programs (a school band program containing several ensembles)
create table public.org_programs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── organizations (the workspace itself)
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  program_id uuid references public.org_programs(id) on delete set null,
  name text not null,
  slug text not null unique,
  org_type text not null default 'marching_band',
    -- drum_corps | marching_band | concert_band | wgi_percussion | wgi_guard
    -- | wgi_winds | winter_guard | indoor_percussion | booster | school_music
    -- | independent
  -- link to the PUBLIC Cadence identity, so competition data can flow in
  public_app_key text,          -- '' (DCI) | 'boa' | 'wgi/guard' | 'uil' | …
  public_ensemble_name text,    -- exact name as that app's data spells it
  -- discovery: may this workspace be found from its public profile?
  directory_visible boolean not null default true,
  accepting_requests boolean not null default true,
  -- ── subscription / entitlement ─────────────────────────────────────
  plan text not null default 'trial'
    check (plan in ('trial', 'ensemble', 'pro', 'program', 'none')),
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'invoice_pending',
                      'grace_period', 'read_only', 'canceled', 'expired')),
  trial_ends_at timestamptz not null default (now() + interval '60 days'),
  grace_ends_at timestamptz,
  renews_at timestamptz,
  billing_owner_user_id uuid references auth.users(id) on delete set null,
  stripe_customer_id text,
  storage_quota_bytes bigint not null default 1073741824,   -- 1 GB on trial/free
  storage_used_bytes bigint not null default 0,
  trial_member_limit int not null default 20,
  -- org-level policy switches (youth safety, comms rules) — see settings keys
  -- below; app reads these, RLS enforces the ones that matter server-side
  settings jsonb not null default jsonb_build_object(
    'student_dms', false,          -- students may DM each other
    'student_staff_dms', false,    -- students may DM staff privately
    'member_created_chats', false, -- non-staff may create chats
    'parents_view_member_chats', false,
    'directory_contacts_visible_to', 'staff'  -- staff | members | none
  ),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index organizations_program_idx on public.organizations (program_id);
create index organizations_public_idx on public.organizations (public_app_key, public_ensemble_name);

-- ── seasons (organizations run year after year; history is preserved)
create table public.org_seasons (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,                       -- '2026 Marching Season'
  starts_on date,
  ends_on date,
  is_current boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index org_seasons_org_idx on public.org_seasons (org_id);

-- ── roles: system defaults are seeded per org and fully editable; orgs may
--    add their own (Battery Staff, Prop Crew, Hospitality, …)
create table public.org_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,                        -- 'director', 'battery_staff', …
  name text not null,
  kind text not null default 'member'
    check (kind in ('owner', 'staff', 'leadership', 'member', 'parent',
                    'booster', 'volunteer', 'alumni', 'guest')),
  permissions text[] not null default '{}',
  is_system boolean not null default false, -- seeded default (still editable)
  sort int not null default 100,
  created_at timestamptz not null default now(),
  unique (org_id, key)
);

-- Permission vocabulary (stored in org_roles.permissions):
--   org.admin           — implies every permission below
--   billing.manage      audit.view          member.manage
--   announce.view       announce.create     announce.edit     announce.urgent
--   chat.create         chat.moderate
--   event.create        event.edit          attendance.view   attendance.edit
--   file.view           file.upload         file.manage
--   group.create        group.manage
--   form.manage         signup.manage       task.manage       poll.manage
--   assignment.manage   audition.manage     equipment.manage
--   staff.access        student.info        parent.info
--   public.manage       — edits the PUBLIC ensemble profile (Ensemble Pro)

-- ── members
create table public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,  -- null = invited placeholder
  role_id uuid not null references public.org_roles(id) on delete restrict,
  display_name text,
  section text,                 -- 'Trumpet', 'Snare', 'Rifle', …
  instrument text,
  grad_year int,
  leadership_title text,        -- 'Drum Major', 'Section Leader', …
  is_minor boolean not null default false,
  status text not null default 'active'
    check (status in ('active', 'pending', 'inactive', 'alumni')),
  season_id uuid references public.org_seasons(id) on delete set null,
  joined_at timestamptz not null default now(),
  custom jsonb not null default '{}',
  unique (org_id, user_id)
);
create index org_members_org_idx on public.org_members (org_id, status);
create index org_members_user_idx on public.org_members (user_id);

-- ── member contact details live apart from the roster so directory reads
--    never leak phone/email/parent contacts to peers
create table public.org_member_contacts (
  member_id uuid primary key references public.org_members(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text,
  phone text,
  address text,
  emergency_name text,
  emergency_phone text,
  notes text,
  updated_at timestamptz not null default now()
);

-- ── groups (sections, staff rooms, parent groups, community groups) —
--    nestable, so Trumpets ⊂ Brass ⊂ Full Ensemble
create table public.org_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  parent_id uuid references public.org_groups(id) on delete cascade,
  name text not null,
  kind text not null default 'section'
    check (kind in ('ensemble', 'section', 'staff', 'leadership', 'parent',
                    'booster', 'volunteer', 'community', 'custom')),
  description text,
  -- members holding any of these role keys join automatically
  auto_role_keys text[] not null default '{}',
  -- members whose section matches any of these join automatically
  auto_sections text[] not null default '{}',
  season_id uuid references public.org_seasons(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index org_groups_org_idx on public.org_groups (org_id);
create index org_groups_parent_idx on public.org_groups (parent_id);

create table public.org_group_members (
  group_id uuid not null references public.org_groups(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, member_id)
);
create index org_group_members_member_idx on public.org_group_members (member_id);

-- ── invites (email, link, code, QR — all the same row)
create table public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  code text not null unique,
  email text,
  role_id uuid references public.org_roles(id) on delete set null,
  group_ids uuid[] not null default '{}',
  section text,
  note text,
  max_uses int not null default 1,
  uses int not null default 0,
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── access requests from the public profile ("I'm a parent in this band")
create table public.org_access_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_kind text not null default 'member',
  message text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_note text,
  unique (org_id, user_id)
);

-- ── audit log
create table public.org_audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index org_audit_org_idx on public.org_audit_log (org_id, created_at desc);

-- ═══ helper functions (SECURITY DEFINER so member checks don't recurse) ═══

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_members m
     where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
  )
$$;

create or replace function public.org_has_perm(p_org uuid, p_perm text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_members m
      join public.org_roles r on r.id = m.role_id
     where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
       and ('org.admin' = any(r.permissions) or p_perm = any(r.permissions))
  )
$$;

-- writable = the subscription still allows creating content. read_only /
-- expired / canceled workspaces keep every byte of history readable.
create or replace function public.org_writable(p_org uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.organizations o
     where o.id = p_org
       and (o.status in ('active', 'past_due', 'invoice_pending', 'grace_period')
            or (o.status = 'trialing' and o.trial_ends_at > now()))
  )
$$;

-- may I write content of this kind here? (membership + permission + plan)
create or replace function public.org_can_write(p_org uuid, p_perm text)
returns boolean language sql security definer stable set search_path = public as $$
  select public.org_has_perm(p_org, p_perm) and public.org_writable(p_org)
$$;

-- my member row id in an org — used by feature tables to attribute content
create or replace function public.org_member_id(p_org uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select m.id from public.org_members m
   where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
   limit 1
$$;

-- am I in this group (directly, or via a descendant/ancestor auto-join)?
create or replace function public.is_group_member(p_group uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_group_members gm
      join public.org_members m on m.id = gm.member_id
     where gm.group_id = p_group and m.user_id = auth.uid() and m.status = 'active'
  )
$$;

revoke execute on function public.is_org_member(uuid) from public, anon;
revoke execute on function public.org_has_perm(uuid, text) from public, anon;
revoke execute on function public.org_writable(uuid) from public, anon;
revoke execute on function public.org_can_write(uuid, text) from public, anon;
revoke execute on function public.org_member_id(uuid) from public, anon;
revoke execute on function public.is_group_member(uuid) from public, anon;
-- …but signed-in users MUST be able to execute them: RLS policies are
-- evaluated with the caller's privileges, so a policy calling a function the
-- caller can't execute fails with "permission denied for function".
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.org_has_perm(uuid, text) to authenticated;
grant execute on function public.org_writable(uuid) to authenticated;
grant execute on function public.org_can_write(uuid, text) to authenticated;
grant execute on function public.org_member_id(uuid) to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated;

-- ═══ seeding: a new organization gets its default roles, groups, season,
--     and its creator as owner — in one transaction, server-side ═══

create or replace function public.seed_new_organization()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  owner_role uuid;
  season uuid;
  full_ens uuid;
begin
  insert into public.org_roles (org_id, key, name, kind, permissions, is_system, sort) values
    (new.id, 'owner', 'Owner', 'owner', array['org.admin','billing.manage'], true, 10),
    (new.id, 'director', 'Director', 'staff', array['org.admin'], true, 20),
    (new.id, 'assistant_director', 'Assistant Director', 'staff',
      array['announce.view','announce.create','announce.edit','announce.urgent','event.create','event.edit',
            'attendance.view','attendance.edit','file.view','file.upload','file.manage','group.create',
            'group.manage','member.manage','chat.create','chat.moderate','form.manage','signup.manage',
            'task.manage','poll.manage','assignment.manage','staff.access','student.info','parent.info'], true, 30),
    (new.id, 'staff', 'Staff', 'staff',
      array['announce.view','announce.create','event.create','attendance.view','attendance.edit',
            'file.view','file.upload','chat.create','task.manage','assignment.manage','staff.access',
            'student.info'], true, 40),
    (new.id, 'instructor', 'Instructor', 'staff',
      array['announce.view','announce.create','attendance.view','attendance.edit','file.view',
            'file.upload','chat.create','assignment.manage','staff.access'], true, 50),
    (new.id, 'leadership', 'Section Leader / Drum Major', 'leadership',
      array['announce.view','announce.create','attendance.view','file.view','file.upload'], true, 60),
    (new.id, 'member', 'Member', 'member', array['announce.view','file.view'], true, 70),
    (new.id, 'parent', 'Parent / Guardian', 'parent', array['announce.view','file.view'], true, 80),
    (new.id, 'booster_officer', 'Booster Officer', 'booster',
      array['announce.view','announce.create','file.view','file.upload','signup.manage'], true, 90),
    (new.id, 'booster', 'Booster', 'booster', array['announce.view','file.view'], true, 100),
    (new.id, 'volunteer', 'Volunteer', 'volunteer', array['announce.view'], true, 110),
    (new.id, 'alumni', 'Alumni', 'alumni', array['announce.view'], true, 120),
    (new.id, 'guest', 'Guest', 'guest', array['announce.view'], true, 130);

  select id into owner_role from public.org_roles where org_id = new.id and key = 'owner';

  insert into public.org_seasons (org_id, name, is_current)
  values (new.id, to_char(now(), 'YYYY') || ' Season', true)
  returning id into season;

  insert into public.org_groups (org_id, name, kind, season_id, auto_role_keys)
  values (new.id, 'Full Ensemble', 'ensemble', season,
          array['member','leadership','staff','instructor','director','assistant_director','owner'])
  returning id into full_ens;

  insert into public.org_groups (org_id, name, kind, season_id, auto_role_keys) values
    (new.id, 'Staff', 'staff', season, array['staff','instructor','director','assistant_director','owner']),
    (new.id, 'All Parents', 'parent', season, array['parent']),
    (new.id, 'Boosters', 'booster', season, array['booster','booster_officer']);

  insert into public.org_members (org_id, user_id, role_id, status, season_id)
  values (new.id, new.created_by, owner_role, 'active', season);

  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (new.id, new.created_by, 'organization.created', 'organization', new.id::text);

  return new;
end $$;

create trigger organizations_seed after insert on public.organizations
  for each row execute function public.seed_new_organization();

-- keep group membership in sync with roles/sections without admin busywork
create or replace function public.sync_member_auto_groups()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rkey text;
begin
  select key into rkey from public.org_roles where id = new.role_id;
  delete from public.org_group_members gm
    using public.org_groups g
   where gm.member_id = new.id and g.id = gm.group_id
     and (cardinality(g.auto_role_keys) > 0 or cardinality(g.auto_sections) > 0)
     and not (rkey = any(g.auto_role_keys)
              or (new.section is not null and new.section = any(g.auto_sections)));
  insert into public.org_group_members (group_id, member_id)
    select g.id, new.id from public.org_groups g
     where g.org_id = new.org_id
       and (rkey = any(g.auto_role_keys)
            or (new.section is not null and new.section = any(g.auto_sections)))
  on conflict do nothing;
  return new;
end $$;

create trigger org_members_autogroup after insert or update of role_id, section
  on public.org_members for each row execute function public.sync_member_auto_groups();

-- Billing is not self-serve. An org admin runs the workspace, but plan,
-- status, trial dates and storage limits are set by the billing system
-- (service role / webhook) — otherwise any admin could grant themselves a
-- paid plan and unlimited storage with one PATCH.
-- SECURITY INVOKER on purpose: this must see the CALLER's role. Inside a
-- SECURITY DEFINER function current_user is the function owner, which would
-- lock out the billing system itself.
create or replace function public.guard_org_billing_fields()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user = 'service_role' then
    return new;                       -- billing system may write anything
  end if;
  if new.plan is distinct from old.plan
     or new.status is distinct from old.status
     or new.trial_ends_at is distinct from old.trial_ends_at
     or new.grace_ends_at is distinct from old.grace_ends_at
     or new.renews_at is distinct from old.renews_at
     or new.storage_quota_bytes is distinct from old.storage_quota_bytes
     or new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception
      'billing_fields_readonly: plan, status, trial dates and storage limits are set by billing';
  end if;
  return new;
end $$;

create trigger organizations_guard_billing before update on public.organizations
  for each row execute function public.guard_org_billing_fields();

-- the audit log records who actually acted, not who the client claims
create or replace function public.stamp_audit_actor()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.actor_user_id := auth.uid();
  return new;
end $$;

create trigger org_audit_actor before insert on public.org_audit_log
  for each row execute function public.stamp_audit_actor();

create trigger organizations_touch before update on public.organizations
  for each row execute function public.touch_updated_at();
create trigger org_programs_touch before update on public.org_programs
  for each row execute function public.touch_updated_at();
create trigger org_member_contacts_touch before update on public.org_member_contacts
  for each row execute function public.touch_updated_at();

-- ═══ RLS ═══
alter table public.org_programs enable row level security;
alter table public.organizations enable row level security;
alter table public.org_seasons enable row level security;
alter table public.org_roles enable row level security;
alter table public.org_members enable row level security;
alter table public.org_member_contacts enable row level security;
alter table public.org_groups enable row level security;
alter table public.org_group_members enable row level security;
alter table public.org_invites enable row level security;
alter table public.org_access_requests enable row level security;
alter table public.org_audit_log enable row level security;

-- organizations: members read their own; any signed-in user may create one;
-- admins update; billing owner/admins handle plan fields (app-enforced)
create policy org_read on public.organizations for select to authenticated
  using (public.is_org_member(id));
create policy org_create on public.organizations for insert to authenticated
  with check (created_by = auth.uid());
create policy org_update on public.organizations for update to authenticated
  using (public.org_has_perm(id, 'org.admin'))
  with check (public.org_has_perm(id, 'org.admin'));

create policy prog_read on public.org_programs for select to authenticated
  using (owner_user_id = auth.uid() or exists (
    select 1 from public.organizations o
     where o.program_id = org_programs.id and public.is_org_member(o.id)));
create policy prog_write on public.org_programs for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

create policy season_read on public.org_seasons for select to authenticated
  using (public.is_org_member(org_id));
create policy season_write on public.org_seasons for all to authenticated
  using (public.org_can_write(org_id, 'org.admin'))
  with check (public.org_can_write(org_id, 'org.admin'));

create policy roles_read on public.org_roles for select to authenticated
  using (public.is_org_member(org_id));
create policy roles_write on public.org_roles for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

create policy members_read on public.org_members for select to authenticated
  using (public.is_org_member(org_id));
create policy members_write on public.org_members for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));
-- members may edit their own roster details (not their role)
create policy members_self on public.org_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- contacts: yourself, or staff holding student.info / parent.info
create policy contacts_read on public.org_member_contacts for select to authenticated
  using (
    member_id = public.org_member_id(org_id)
    or public.org_has_perm(org_id, 'student.info')
    or public.org_has_perm(org_id, 'parent.info')
  );
create policy contacts_self_write on public.org_member_contacts for all to authenticated
  using (member_id = public.org_member_id(org_id))
  with check (member_id = public.org_member_id(org_id));
create policy contacts_staff_write on public.org_member_contacts for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

create policy groups_read on public.org_groups for select to authenticated
  using (public.is_org_member(org_id));
create policy groups_write on public.org_groups for all to authenticated
  using (public.org_can_write(org_id, 'group.create'))
  with check (public.org_can_write(org_id, 'group.create'));

create policy gm_read on public.org_group_members for select to authenticated
  using (exists (select 1 from public.org_groups g
                  where g.id = group_id and public.is_org_member(g.org_id)));
create policy gm_write on public.org_group_members for all to authenticated
  using (exists (select 1 from public.org_groups g
                  where g.id = group_id and public.org_can_write(g.org_id, 'group.manage')))
  with check (exists (select 1 from public.org_groups g
                  where g.id = group_id and public.org_can_write(g.org_id, 'group.manage')));

create policy invites_admin on public.org_invites for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

create policy reqs_own on public.org_access_requests for select to authenticated
  using (user_id = auth.uid() or public.org_has_perm(org_id, 'member.manage'));
create policy reqs_insert on public.org_access_requests for insert to authenticated
  with check (user_id = auth.uid());
create policy reqs_review on public.org_access_requests for update to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

create policy audit_read on public.org_audit_log for select to authenticated
  using (public.org_has_perm(org_id, 'audit.view') or public.org_has_perm(org_id, 'org.admin'));
create policy audit_insert on public.org_audit_log for insert to authenticated
  with check (public.is_org_member(org_id));

-- ── redeeming an invite: server-side so codes never expose the org to
--    non-members, and so role/group assignment can't be forged
create or replace function public.redeem_org_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv public.org_invites%rowtype;
  member uuid;
  season uuid;
begin
  select * into inv from public.org_invites
   where code = p_code and (expires_at is null or expires_at > now()) and uses < max_uses;
  if not found then raise exception 'invite_invalid'; end if;
  if auth.uid() is null then raise exception 'auth_required'; end if;

  select id into member from public.org_members where org_id = inv.org_id and user_id = auth.uid();
  if member is not null then return inv.org_id; end if;

  select id into season from public.org_seasons
   where org_id = inv.org_id and is_current order by created_at desc limit 1;

  insert into public.org_members (org_id, user_id, role_id, section, status, season_id)
  values (inv.org_id, auth.uid(),
          coalesce(inv.role_id, (select id from public.org_roles where org_id = inv.org_id and key = 'member')),
          inv.section, 'active', season)
  returning id into member;

  insert into public.org_group_members (group_id, member_id)
    select unnest(inv.group_ids), member on conflict do nothing;

  update public.org_invites set uses = uses + 1 where id = inv.id;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (inv.org_id, auth.uid(), 'member.joined_via_invite', 'member', member::text);
  return inv.org_id;
end $$;
revoke execute on function public.redeem_org_invite(text) from public, anon;
grant execute on function public.redeem_org_invite(text) to authenticated;

-- ── public discovery surface: name/type only, never private content
create view public.org_directory
  with (security_invoker = false) as
  select id, name, slug, org_type, public_app_key, public_ensemble_name, accepting_requests
    from public.organizations
   where directory_visible;
grant select on public.org_directory to anon, authenticated;

-- ═══ Owner workflow queries ═══
-- Approve an access request, then add the member with the role you intend:
--   update org_access_requests set status='approved', reviewed_at=now() where id='…';
-- Extend a trial:
--   update organizations set trial_ends_at = now() + interval '30 days' where slug='…';
-- Activate a paid plan after payment:
--   update organizations set plan='pro', status='active',
--     renews_at = now() + interval '1 year', storage_quota_bytes = 26843545600
--    where slug='…';
-- Nightly sweep (trial → read_only, grace → read_only) — run as a cron job:
--   update organizations set status='read_only'
--    where (status='trialing' and trial_ends_at < now())
--       or (status='grace_period' and grace_ends_at < now());
