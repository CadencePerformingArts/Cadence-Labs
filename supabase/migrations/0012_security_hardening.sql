-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — workspace security hardening (stop-the-line fixes)
--
-- Seven vulnerabilities found in an adversarial audit of 0001-0011, each
-- fixed additively here with the attack it closes written out, because the
-- regression suite (scripts/test_db_security.py) replays these exact
-- attacks against a scratch database on every change:
--
--   0A  a member could PATCH their own org_members.role_id to Owner —
--       the members_self policy restricted rows, not columns
--   0B  org_members.role_id / org_invites.role_id could reference a role
--       from ANOTHER organization, importing its permissions cross-tenant
--   0C  storage accounting trusted the client's size_bytes, admins could
--       zero storage_used_bytes, and concurrent uploads raced the quota
--   0D  redeem_org_invite read uses/max_uses without locking — two
--       concurrent redemptions of the last use both succeeded
--   0E  claim_drill_dot overwrote another member's claimed dot silently
--   0F  youth-safety DM rules keyed on the client-supplied chat kind —
--       a two-person "group" chat bypassed pair_may_dm entirely
--   0G  usage_events.user_id was client-spoofable
--
-- Plus smaller items from the same audit: 0011's drill policies applied
-- to anon, and an approved Ensemble Pro claimant could be locked out of a
-- profile row created by someone else.
--
-- Append-only: nothing here rewrites an applied migration. Regenerate the
-- bundles with scripts/gen_sql_bundles.py after editing.
--
-- Depends on: 0005 (org core), 0006 (comms), 0008 (files), 0011 (drill).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 0B first: roles must belong to the org that uses them ─────────────
-- (before 0A so the role-change RPC below can rely on it)

-- composite key target for same-org foreign keys
alter table public.org_roles
  add constraint org_roles_org_id_id_key unique (org_id, id);

-- validate existing rows loudly rather than enforce onto bad data
do $$
declare bad int;
begin
  select count(*) into bad
    from public.org_members m join public.org_roles r on r.id = m.role_id
   where r.org_id <> m.org_id;
  if bad > 0 then
    raise exception 'org_members has % cross-org role assignment(s); fix before applying 0012', bad;
  end if;
  select count(*) into bad
    from public.org_invites i join public.org_roles r on r.id = i.role_id
   where r.org_id <> i.org_id;
  if bad > 0 then
    raise exception 'org_invites has % cross-org role reference(s); fix before applying 0012', bad;
  end if;
end $$;

alter table public.org_members
  add constraint org_members_role_same_org
  foreign key (org_id, role_id) references public.org_roles (org_id, id);

alter table public.org_invites
  add constraint org_invites_role_same_org
  foreign key (org_id, role_id) references public.org_roles (org_id, id);

-- ── 0A: membership rows can no longer change their own privileges ─────
-- The guard runs on EVERY update path. Direct PostgREST traffic runs as
-- `authenticated`; guarded RPCs below run as the function owner and the
-- billing system as service_role — both pass. Same pattern (SECURITY
-- INVOKER, current_user inspection) as guard_org_billing_fields in 0005.
create or replace function public.guard_member_update()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;                        -- service role and definer RPCs
  end if;

  -- identity and tenancy never change through the API, for anyone
  if new.org_id is distinct from old.org_id
     or new.user_id is distinct from old.user_id then
    raise exception 'member_identity_readonly: org and user of a membership cannot change';
  end if;

  -- role changes only through set_member_role(), which audits and protects
  -- the last owner — a raw PATCH cannot do either
  if new.role_id is distinct from old.role_id then
    raise exception 'role_change_requires_rpc: change roles with set_member_role()';
  end if;

  -- everything else that carries privilege or capacity is staff-only
  if not public.org_has_perm(old.org_id, 'member.manage') then
    if new.status is distinct from old.status
       or new.season_id is distinct from old.season_id
       or new.section is distinct from old.section then
      raise exception 'member_fields_staff_only: only roster managers may change status, season or section';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_member_update() from public, anon, authenticated;

drop trigger if exists org_members_guard on public.org_members;
create trigger org_members_guard before update on public.org_members
  for each row execute function public.guard_member_update();

-- the one sanctioned way to change a member's role
create or replace function public.set_member_role(p_member uuid, p_role uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.org_members%rowtype;
  admins int;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;

  select * into m from public.org_members where id = p_member for update;
  if not found then raise exception 'no_such_member'; end if;

  if not public.org_can_write(m.org_id, 'member.manage') then
    raise exception 'not_allowed: member.manage required';
  end if;

  -- nobody promotes (or demotes) themselves — a second admin must do it
  if m.user_id = auth.uid() then
    raise exception 'self_role_change_forbidden: another administrator must change your role';
  end if;

  -- the role must belong to this org (also enforced by the 0B constraint)
  if not exists (select 1 from public.org_roles r
                  where r.id = p_role and r.org_id = m.org_id) then
    raise exception 'role_not_in_org';
  end if;

  -- never leave the workspace without an active administrator
  if exists (select 1 from public.org_roles r
              where r.id = m.role_id and 'org.admin' = any (r.permissions))
     and not exists (select 1 from public.org_roles r
                      where r.id = p_role and 'org.admin' = any (r.permissions)) then
    select count(*) into admins
      from public.org_members mm
      join public.org_roles rr on rr.id = mm.role_id
     where mm.org_id = m.org_id and mm.status = 'active'
       and mm.id <> m.id and 'org.admin' = any (rr.permissions);
    if admins = 0 then
      raise exception 'last_admin: promote someone else before demoting the only administrator';
    end if;
  end if;

  update public.org_members set role_id = p_role where id = p_member;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (m.org_id, auth.uid(), 'member.role_changed', 'member', p_member::text);
end $$;
revoke execute on function public.set_member_role(uuid, uuid) from public, anon;
grant execute on function public.set_member_role(uuid, uuid) to authenticated;

-- ── 0C: storage accounting the client cannot lie to ───────────────────

-- usage joins the guarded billing fields (recreate = replace 0005's guard)
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
  return new;
end $$;

-- quota check serialized: lock the org row so two concurrent uploads can't
-- both read the same "used" figure and both squeeze under the limit
create or replace function public.enforce_org_storage_quota()
returns trigger language plpgsql security definer set search_path = public as $$
declare o public.organizations%rowtype;
begin
  select * into o from public.organizations where id = new.org_id for update;
  if not found then raise exception 'unknown_org'; end if;
  if o.storage_used_bytes + coalesce(new.size_bytes, 0) > o.storage_quota_bytes then
    raise exception 'storage_quota_exceeded'
      using hint = 'This workspace is out of storage. Remove files or upgrade the plan.';
  end if;
  return new;
end $$;

-- size_bytes: a preflight estimate at insert, then reconciled from the
-- actual stored object. Clients cannot edit it afterwards.
create or replace function public.guard_file_size()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.size_bytes is distinct from old.size_bytes then
    raise exception 'size_readonly: file size is reconciled from storage, not set by clients';
  end if;
  return new;
end $$;
revoke execute on function public.guard_file_size() from public, anon, authenticated;

drop trigger if exists org_files_guard_size on public.org_files;
create trigger org_files_guard_size before update on public.org_files
  for each row execute function public.guard_file_size();

-- reconcile a file row against the object that actually landed in the
-- bucket. Callable by any member who can see the file; reads only the
-- object's own metadata, so there is nothing to abuse.
create or replace function public.sync_file_size(p_file uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  f public.org_files%rowtype;
  actual bigint;
begin
  select * into f from public.org_files where id = p_file;
  if not found then raise exception 'no_such_file'; end if;
  if not public.is_org_member(f.org_id) then raise exception 'not_allowed'; end if;

  select nullif(o.metadata ->> 'size', '')::bigint into actual
    from storage.objects o
   where o.bucket_id = 'ensemble' and o.name = f.storage_path
   order by o.created_at desc limit 1;

  -- update the row only; the existing bump_org_storage trigger (0008) does
  -- the org-usage accounting on any size_bytes change, so touching it here
  -- too would double-count
  if actual is not null and actual is distinct from f.size_bytes then
    update public.org_files set size_bytes = actual where id = p_file;
  end if;
  return coalesce(actual, f.size_bytes);
end $$;
revoke execute on function public.sync_file_size(uuid) from public, anon;
grant execute on function public.sync_file_size(uuid) to authenticated;

-- ── 0D: invite redemption is atomic ───────────────────────────────────
create or replace function public.redeem_org_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv public.org_invites%rowtype;
  member uuid;
  season uuid;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;

  -- lock the invite so the last use cannot be redeemed twice concurrently
  select * into inv from public.org_invites where code = p_code for update;
  if not found or (inv.expires_at is not null and inv.expires_at <= now()) then
    raise exception 'invite_invalid';
  end if;

  -- idempotent: an existing member re-entering the code just lands home,
  -- without consuming a use — checked BEFORE the exhausted-uses guard so a
  -- fully-used invite still lets its own members back in
  select id into member from public.org_members
   where org_id = inv.org_id and user_id = auth.uid();
  if member is not null then return inv.org_id; end if;

  if inv.uses >= inv.max_uses then raise exception 'invite_invalid'; end if;

  select id into season from public.org_seasons
   where org_id = inv.org_id and is_current order by created_at desc limit 1;

  insert into public.org_members (org_id, user_id, role_id, section, status, season_id)
  values (inv.org_id, auth.uid(),
          coalesce(inv.role_id, (select id from public.org_roles
                                  where org_id = inv.org_id and key = 'member')),
          inv.section, 'active', season)
  returning id into member;

  insert into public.org_group_members (group_id, member_id)
    select unnest(inv.group_ids), member on conflict do nothing;

  update public.org_invites set uses = uses + 1 where id = inv.id;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (inv.org_id, auth.uid(), 'member.joined_via_invite', 'member', member::text);
  return inv.org_id;
end $$;

-- ── 0E: a dot belongs to whoever claimed it ───────────────────────────
create or replace function public.claim_drill_dot(p_performer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  perf public.drill_performers%rowtype;
  v_org uuid;
  v_me uuid;
begin
  select p.* into perf from public.drill_performers p where p.id = p_performer for update;
  if not found then raise exception 'no such dot'; end if;
  select s.org_id into v_org from public.drill_shows s where s.id = perf.show_id;
  v_me := public.org_member_id(v_org);
  if v_me is null then raise exception 'not a member of this workspace'; end if;

  -- taken by someone else? members cannot steal; drill managers use
  -- assign_drill_dot() to reassign on purpose
  if perf.member_id is not null and perf.member_id <> v_me then
    raise exception 'dot_taken'
      using hint = 'That dot is claimed by someone else. Ask your drill staff to reassign it.';
  end if;

  update public.drill_performers p set member_id = null
   where p.member_id = v_me and p.show_id = perf.show_id and p.id <> p_performer;
  update public.drill_performers set member_id = v_me where id = p_performer;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (v_org, auth.uid(), 'drill.dot_claimed', 'drill_performer', p_performer::text);
end $$;

-- staff reassignment, the deliberate path (p_member null = clear the dot)
create or replace function public.assign_drill_dot(p_performer uuid, p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  perf public.drill_performers%rowtype;
  v_org uuid;
begin
  select p.* into perf from public.drill_performers p where p.id = p_performer for update;
  if not found then raise exception 'no such dot'; end if;
  select s.org_id into v_org from public.drill_shows s where s.id = perf.show_id;
  if not public.org_can_write(v_org, 'drill.manage') then
    raise exception 'not_allowed: drill.manage required';
  end if;
  if p_member is not null and not exists (
      select 1 from public.org_members m where m.id = p_member and m.org_id = v_org) then
    raise exception 'member_not_in_org';
  end if;
  if p_member is not null then
    update public.drill_performers p set member_id = null
     where p.member_id = p_member and p.show_id = perf.show_id and p.id <> p_performer;
  end if;
  update public.drill_performers set member_id = p_member where id = p_performer;
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id)
  values (v_org, auth.uid(),
          case when p_member is null then 'drill.dot_cleared' else 'drill.dot_assigned' end,
          'drill_performer', p_performer::text);
end $$;
revoke execute on function public.assign_drill_dot(uuid, uuid) from public, anon;
grant execute on function public.assign_drill_dot(uuid, uuid) to authenticated;

-- ── 0F: youth safety follows the people in the room, not its label ────
-- Chats created by someone holding chat.create (staff-sanctioned,
-- moderated spaces) are exempt from pair rules; anything a plain member
-- creates is treated exactly like a DM no matter what kind it claims.
alter table public.chats
  add column if not exists safety_exempt boolean not null default false;

-- existing rooms: everything that isn't a DM predates member-created
-- abuse (member_created_chats orgs get the stricter rule from now on)
update public.chats set safety_exempt = true where kind <> 'dm';

create or replace function public.stamp_chat_safety()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.safety_exempt :=
    new.kind in ('org', 'staff')      -- structural rooms are staff spaces
    or public.org_has_perm(new.org_id, 'chat.create');
  return new;
end $$;
revoke execute on function public.stamp_chat_safety() from public, anon, authenticated;

drop trigger if exists chats_stamp_safety on public.chats;
create trigger chats_stamp_safety before insert on public.chats
  for each row execute function public.stamp_chat_safety();

-- pair rules now apply to every non-exempt chat, whatever its kind says
create or replace function public.dm_allowed(p_chat uuid, p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when (select safety_exempt and kind is distinct from 'dm'
            from public.chats where id = p_chat)
      then true
    else not exists (
      select 1 from public.chat_members cm
       where cm.chat_id = p_chat and cm.member_id <> p_member
         and not public.pair_may_dm(cm.member_id, p_member))
  end
$$;

-- removing people cannot convert a sanctioned room into an unsafe pair:
-- when a non-exempt chat shrinks to two, the remaining pair must pass
create or replace function public.recheck_chat_pair()
returns trigger language plpgsql security definer set search_path = public as $$
declare a uuid; b uuid; exempt boolean; k text;
begin
  select safety_exempt, kind into exempt, k from public.chats where id = old.chat_id;
  if exempt and k is distinct from 'dm' then return old; end if;
  select min(member_id::text)::uuid, max(member_id::text)::uuid into a, b
    from public.chat_members where chat_id = old.chat_id;
  if a is not null and b is not null and a <> b
     and (select count(*) from public.chat_members where chat_id = old.chat_id) = 2
     and not public.pair_may_dm(a, b) then
    raise exception 'pair_not_allowed'
      using hint = 'Removing that member would leave a conversation these two may not have.';
  end if;
  return old;
end $$;
revoke execute on function public.recheck_chat_pair() from public, anon, authenticated;

drop trigger if exists chat_members_recheck_pair on public.chat_members;
create trigger chat_members_recheck_pair after delete on public.chat_members
  for each row execute function public.recheck_chat_pair();

-- ── 0G: analytics carry the real identity or none ─────────────────────
create or replace function public.stamp_usage_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();          -- null for anonymous, never spoofable
  if new.event is null or new.event not in ('view', 'action') then
    new.event := 'view';
  end if;
  -- session_id is a uuid column (fixed-size, safe); text fields are capped
  -- so a client cannot stuff private content or oversized payloads through
  new.app := left(coalesce(new.app, ''), 32);
  new.screen := left(coalesce(new.screen, ''), 64);
  new.detail := left(new.detail, 120);
  new.ref := left(new.ref, 120);
  return new;
end $$;
revoke execute on function public.stamp_usage_event() from public, anon, authenticated;

drop trigger if exists usage_events_stamp on public.usage_events;
create trigger usage_events_stamp before insert on public.usage_events
  for each row execute function public.stamp_usage_event();

-- ── 0011 cleanup: drill policies were the only ones without a role ────
alter policy drill_shows_read on public.drill_shows to authenticated;
alter policy drill_shows_write on public.drill_shows to authenticated;
alter policy drill_performers_read on public.drill_performers to authenticated;
alter policy drill_performers_write on public.drill_performers to authenticated;
alter policy drill_sets_read on public.drill_sets to authenticated;
alter policy drill_sets_write on public.drill_sets to authenticated;

-- ── approved claimants own their public profile, whoever created it ───
-- (fixes: a stale owner_user_id on ensemble_profiles blocked the flow
-- 0004 intended — approval is the authority, not the row's creator)
drop policy if exists ensemble_profiles_owner_update on public.ensemble_profiles;
create policy ensemble_profiles_owner_update on public.ensemble_profiles
  for update to authenticated
  using (public.has_approved_ensemble_claim(app_key, ensemble_name))
  with check (public.has_approved_ensemble_claim(app_key, ensemble_name));

create or replace function public.stamp_profile_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- the acting approved claimant becomes the owner of record
  if auth.uid() is not null then new.owner_user_id := auth.uid(); end if;
  return new;
end $$;
revoke execute on function public.stamp_profile_owner() from public, anon, authenticated;

drop trigger if exists ensemble_profiles_stamp_owner on public.ensemble_profiles;
create trigger ensemble_profiles_stamp_owner before update on public.ensemble_profiles
  for each row execute function public.stamp_profile_owner();

-- ── 0006 grant drift: fifteen policy helpers were revoked from public but
--    never re-granted to authenticated (0006:405-419), so every RLS policy
--    that calls them raised "permission denied for function" for real
--    signed-in users — chat creation, post visibility, DM safety and the
--    notification rule were all effectively broken. A policy is evaluated
--    with the caller's privileges, so these must be executable by
--    authenticated; they stay revoked from anon/public. (0010 did this for
--    0007's helpers; 0006's were missed.)
grant execute on function public.org_plan_has(uuid, text) to authenticated;
grant execute on function public.can_see_post(uuid) to authenticated;
grant execute on function public.can_edit_post(uuid) to authenticated;
grant execute on function public.post_member_id(uuid) to authenticated;
grant execute on function public.post_org(uuid) to authenticated;
grant execute on function public.chat_org(uuid) to authenticated;
grant execute on function public.chat_creator_or_mod(uuid) to authenticated;
grant execute on function public.chat_member_id(uuid) to authenticated;
grant execute on function public.is_chat_member(uuid) to authenticated;
grant execute on function public.member_is_staff(uuid) to authenticated;
grant execute on function public.pair_may_dm(uuid, uuid) to authenticated;
grant execute on function public.dm_allowed(uuid, uuid) to authenticated;
grant execute on function public.may_create_chat(uuid) to authenticated;
grant execute on function public.chat_is_open(uuid) to authenticated;
grant execute on function public.should_notify(uuid, text, uuid, text, text) to authenticated;
