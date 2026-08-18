-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — public communities (open-join workspaces)
--
-- Every workspace so far is private by construction: you get in with an
-- invite code a director handed you, and `org_read` shows you the row only
-- once you are already a member. That is right for a real ensemble, and
-- wrong for the first thing a curious person sees. Someone who installs
-- Cadence to follow DCI scores lands on /ensemble/ and is asked either for
-- a code they do not have or to start a 60-day trial they do not want, and
-- learns nothing about what a workspace actually is.
--
-- This adds one narrow exception: an organization the platform marks
-- public, which any signed-in person may join with a single tap. It exists
-- for onboarding — a fans community where you can see announcements and the
-- competition calendar, and understand what groups are before you are
-- invited to one that matters.
--
-- The mechanism is deliberately small and the defaults are deliberately
-- timid:
--
--   * Only the service role (or a platform admin acting through it) can
--     mark an organization public. A director CANNOT flip their own
--     workspace public — `org_update` grants any org.admin holder a plain
--     PATCH on the organizations row, so without the guard below a school
--     band's roster, announcements and calendar would be one checkbox away
--     from being world-joinable. That guard is the whole security story of
--     this file.
--   * A public joiner lands in the `guest` role, which the seed trigger
--     gives exactly one permission: announce.view. No files, no chat, no
--     roster management, no DMs. Widening that is a deliberate act on one
--     organization, not a default.
--   * Nothing here creates a community. The mechanism ships; the
--     organization is data, seeded once per project (see the bottom of this
--     file), because it needs a real owner account to exist first.
--
-- Depends on: 0005 (organizations, org_members, seed trigger, guard),
--             0012 (the guard's current INVOKER/current_user shape).
-- ═══════════════════════════════════════════════════════════════════════

-- ── the columns ────────────────────────────────────────────────────────
alter table public.organizations
  add column if not exists is_public boolean not null default false,
  add column if not exists public_blurb text,
  -- resolved by KEY, not by id: a role id would need a composite foreign
  -- key to stay inside the org (0012's org_roles_org_id_id_key exists for
  -- exactly that reason), and a key cannot accidentally point at another
  -- workspace's role at all.
  add column if not exists public_join_role_key text not null default 'guest';

comment on column public.organizations.is_public is
  'Open-join community. Service-role only — see guard_org_billing_fields.';

-- ── the guard: a director cannot publish their own workspace ───────────
-- Same shape as 0012's version, with the three new fields folded into the
-- protected set. Recreated rather than altered because it is one function;
-- the trigger from 0005 keeps pointing at it.
create or replace function public.guard_org_billing_fields()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.plan is distinct from old.plan
     or new.status is distinct from old.status
     or new.trial_ends_at is distinct from old.trial_ends_at
     or new.grace_ends_at is distinct from old.grace_ends_at
     or new.renews_at is distinct from old.renews_at
     or new.storage_quota_bytes is distinct from old.storage_quota_bytes
     or new.storage_used_bytes is distinct from old.storage_used_bytes
     or new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception
      'billing_fields_readonly: plan, status, dates and storage accounting are set by the system';
  end if;
  -- publishing a workspace to the world is not a workspace-admin decision
  if new.is_public is distinct from old.is_public
     or new.public_blurb is distinct from old.public_blurb
     or new.public_join_role_key is distinct from old.public_join_role_key then
    raise exception
      'public_flags_readonly: only Cadence can make a workspace open to the public';
  end if;
  return new;
end $$;

-- ── discovery: the only way a non-member learns a public org exists ────
-- `org_read` is is_org_member(id), so a stranger cannot select the row.
-- This definer function returns just enough to render a join card, for
-- organizations that have explicitly opted in — and nothing for any other.
create or replace function public.list_public_orgs()
returns table (id uuid, name text, slug text, blurb text, members int)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.slug, o.public_blurb,
         (select count(*)::int from public.org_members m
           where m.org_id = o.id and m.status = 'active')
    from public.organizations o
   where o.is_public
   order by o.name
$$;
revoke all on function public.list_public_orgs() from public;
-- anon too: the join card should be visible to someone who has not signed
-- in yet, so the page can explain the community before asking for an
-- account. Nothing here is private — it is the point of the flag.
grant execute on function public.list_public_orgs() to anon, authenticated;

-- ── the join ───────────────────────────────────────────────────────────
create or replace function public.join_public_org(p_org uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  o public.organizations%rowtype;
  member uuid;
  role_id uuid;
  season uuid;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;

  select * into o from public.organizations where id = p_org;
  if not found or not o.is_public then raise exception 'not_a_public_community'; end if;

  -- idempotent, exactly like redeem_org_invite: joining twice just lands
  -- you home instead of creating a second membership
  select id into member from public.org_members
   where org_id = o.id and user_id = auth.uid();
  if member is not null then return o.id; end if;

  select id into role_id from public.org_roles
   where org_id = o.id and key = coalesce(o.public_join_role_key, 'guest');
  if role_id is null then
    select id into role_id from public.org_roles where org_id = o.id and key = 'guest';
  end if;
  if role_id is null then raise exception 'community_misconfigured'; end if;

  select id into season from public.org_seasons
   where org_id = o.id and is_current order by created_at desc limit 1;

  insert into public.org_members (org_id, user_id, role_id, status, season_id)
  values (o.id, auth.uid(), role_id, 'active', season)
  returning id into member;

  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (o.id, auth.uid(), 'member.joined_public', 'member', member::text);
  return o.id;
end $$;
revoke all on function public.join_public_org(uuid) from public, anon;
grant execute on function public.join_public_org(uuid) to authenticated;

-- ── leaving, because a door you cannot walk back out of is a trap ──────
-- Only for public communities, and never for the last owner of one.
create or replace function public.leave_public_org(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o public.organizations%rowtype;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  select * into o from public.organizations where id = p_org;
  if not found or not o.is_public then raise exception 'not_a_public_community'; end if;
  if exists (select 1 from public.org_members m
              join public.org_roles r on r.id = m.role_id
             where m.org_id = o.id and m.user_id = auth.uid() and r.kind = 'owner') then
    raise exception 'owner_cannot_leave';
  end if;
  delete from public.org_members where org_id = o.id and user_id = auth.uid();
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (o.id, auth.uid(), 'member.left_public', 'member', null);
end $$;
revoke all on function public.leave_public_org(uuid) from public, anon;
grant execute on function public.leave_public_org(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- SEEDING A COMMUNITY (data, not schema — run once per project)
--
-- A community needs an owner account, so it cannot be created by a
-- migration that may run against an empty auth.users. Run this in the SQL
-- editor, replacing the email, after the owner account exists:
--
--   -- 1. create the workspace as the owner (the seed trigger builds its
--   --    roles, groups, season and owner membership)
--   insert into public.organizations (name, slug, created_by)
--   select 'Cadence DCI Fans', 'dci-fans', u.id
--     from auth.users u where u.email = 'YOUR-EMAIL'
--   on conflict (slug) do nothing;
--
--   -- 2. mark it public and give it a home that does not expire. Run as
--   --    the SQL editor's role (postgres), which the guard lets through.
--   update public.organizations set
--     is_public = true,
--     public_blurb = 'An open community for drum corps fans — announcements, '
--                    'the competition calendar, and a place to see how a '
--                    'Cadence workspace works before you join your own.',
--     public_join_role_key = 'guest',
--     plan = 'pro', status = 'active',
--     renews_at = now() + interval '100 years'
--   where slug = 'dci-fans';
--
-- Status 'active' keeps 0018's hourly sweep from ever moving it read-only.
-- The 'guest' role is announce.view and nothing else: joiners read
-- announcements and cannot post, upload, chat, DM or see the roster. Widen
-- that only deliberately, and remember that an open community can contain
-- minors — every youth-safety rule in 0006/0012 is per-organization, so a
-- public workspace with chat enabled is a public chat room with the
-- moderation burden that implies.
-- ═══════════════════════════════════════════════════════════════════════
