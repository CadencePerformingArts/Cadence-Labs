-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — notifications that reach the right people, at the right time
--
-- 0014 enqueued from AFTER INSERT row triggers. Three consequences, all
-- real, all closed here.
--
--   1. CONFIDENTIALITY. docs/ensemble/feed.html writes the post, then the
--      post_targets rows in a SECOND request. post_audience() (0014:72-88)
--      resolves "no target rows" as the whole organization, and at INSERT
--      time there are none — so an announcement aimed at one section
--      enqueued a notification carrying left(title, 140) to every active
--      member of the org, whose RLS then denied them the post itself. The
--      title of a restricted announcement is not noise, it is a leak.
--      org_events + org_event_targets had the same shape.
--
--   2. PREFERENCES. should_notify() was called with scope 'announcement' /
--      'event', scope_id = the post/event id, and channel 'inapp'. But
--      org_notification_prefs constrains scope to ('org', 'group', 'chat')
--      and channel to ('push', 'email') (0006:209,211), and scope_id means
--      the org/group/chat — so the lookup could never match a row. The
--      coalesce fell through to 'all' and every member preference was
--      ignored, level 'none' included, exactly opposite to what 0014's own
--      header promises.
--
--   3. SCHEDULING. posts.publish_at is "future = scheduled" (0006:69). The
--      trigger returned early for a future-dated post, and no later event
--      ever re-fired it, so a scheduled must-read announcement notified
--      nobody, ever.
--
-- The shape of the fix: enqueueing is no longer a side effect of INSERT.
--
--   • public.publish_post(post) is an explicit, permission-checked step the
--     client calls AFTER the targets are written. Nothing is enqueued until
--     it does, so a client that dies between the two calls leaves an
--     announcement that never notifies — the safe failure — and never a
--     title fanned out to the whole organization.
--   • A post scheduled for later registers a release for its publish_at
--     instead of enqueueing now. release_due_notifications() drains what is
--     due, resolving the audience at that moment; claim_notifications()
--     runs it before every worker batch, and pg_cron runs it each minute
--     where the platform allows.
--   • Events keep their trigger, but DEFERRED: org_event_create() (0007)
--     writes the event and its targets in one transaction, so at COMMIT the
--     audience is finally correct. An edit that turns RSVP on rewrites its
--     targets in a separate request, so that path registers a short-delayed
--     release rather than resolving an audience that is still moving —
--     docs/ensemble/calendar.html flushes it immediately by calling
--     publish_event() once its own writes have landed.
--
-- Also here: organizations.storage_quota_bytes moves to 5 GiB, the number
-- the Trial card in docs/ensemble/core.js PLANS has always advertised.
--
-- Depends on: 0005 (organizations), 0006 (posts, post_targets, prefs,
-- should_notify), 0007 (org_events, org_event_targets, can_manage_event),
-- 0014 (the queue, enqueue_notification, post_audience).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. a preference the table can actually hold ────────────────────────
-- The in-app bell is a channel a member mutes like any other; 0014 asked
-- should_notify() about it a migration before the column could store it.
-- docs/ensemble/core.js already offers the row and folds it away when the
-- database refuses the value — after this it stops refusing.
alter table public.org_notification_prefs
  drop constraint if exists org_notification_prefs_channel_check;
alter table public.org_notification_prefs
  add constraint org_notification_prefs_channel_check
  check (channel in ('inapp', 'push', 'email'));

comment on column public.org_notification_prefs.channel is
  'inapp | push | email. Widened from (push, email) in 0019 so the in-app '
  'bell can be muted like any other channel — every enqueue path asks '
  'should_notify(member, ''org'', org_id, channel, priority).';

-- ── 2. the release ledger ──────────────────────────────────────────────
-- One row per post/event whose notification has been approved, with the
-- moment it becomes due. Nothing is enqueued from an INSERT any more; this
-- is the only thing that says "this may now go out".
create table if not exists public.notification_releases (
  subject_kind text not null check (subject_kind in ('post', 'event')),
  subject_id uuid not null,
  org_id uuid not null references public.organizations(id) on delete cascade,
  release_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (subject_kind, subject_id)
);
create index if not exists notification_releases_due
  on public.notification_releases (release_at) where released_at is null;

alter table public.notification_releases enable row level security;

comment on table public.notification_releases is
  'Service-role only by design: RLS is on with no policies, so no client can read or write it. One row per post/event cleared for notification, with the moment it becomes due — release_due_notifications() resolves the audience then, never at INSERT time.';

-- ── 3. audience → queue, resolved at release time ──────────────────────
-- Both of these read the row fresh instead of trusting a trigger's NEW, so
-- a post whose targets, priority or ack requirement changed between the
-- write and the release is fanned out as it stands now.
create or replace function public.enqueue_post_notifications(p_post uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  p record;
  m uuid;
  pay jsonb;
  n int := 0;
begin
  select id, org_id, author_member_id, title, priority, requires_ack, archived, publish_at
    into p from public.posts where id = p_post;
  if not found then return 0; end if;
  if p.requires_ack is not true or p.archived is true then return 0; end if;
  if p.publish_at > now() then return 0; end if;   -- not published yet

  pay := jsonb_build_object('post_id', p.id, 'title', left(coalesce(p.title, 'Announcement'), 140));
  for m in select member_id from public.post_audience(p.id) loop
    if m = p.author_member_id then continue; end if;   -- not your own post
    if public.should_notify(m, 'org', p.org_id, 'inapp', p.priority) then
      perform public.enqueue_notification(p.org_id, m, null, 'ack_post', 'inapp',
        p.priority, pay, 'ack:' || p.id || ':' || m, now());
      n := n + 1;
    end if;
    if public.should_notify(m, 'org', p.org_id, 'push', p.priority) then
      perform public.enqueue_notification(p.org_id, m, null, 'ack_post', 'push',
        p.priority, pay, 'ack:' || p.id || ':' || m, now());
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.enqueue_post_notifications(uuid)
  from public, anon, authenticated;

-- Event targeting is group-based (org_event_targets.group_id); no targets
-- means the whole org — same rule as 0014, applied at the right moment.
create or replace function public.enqueue_event_notifications(p_event uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  e record;
  m uuid;
  pay jsonb;
  n int := 0;
begin
  select id, org_id, title, starts_at, rsvp_required
    into e from public.org_events where id = p_event;
  if not found then return 0; end if;
  if e.rsvp_required is not true then return 0; end if;

  pay := jsonb_build_object('event_id', e.id, 'title', left(coalesce(e.title, 'Event'), 140),
                            'starts_at', e.starts_at);
  for m in
    select mm.id from public.org_members mm
     where mm.org_id = e.org_id and mm.status = 'active'
       and (
         not exists (select 1 from public.org_event_targets et where et.event_id = e.id)
         or exists (select 1 from public.org_event_targets et
                     join public.org_group_members gm on gm.group_id = et.group_id
                    where et.event_id = e.id and gm.member_id = mm.id))
  loop
    if public.should_notify(m, 'org', e.org_id, 'inapp', 'normal') then
      perform public.enqueue_notification(e.org_id, m, null, 'rsvp', 'inapp',
        'normal', pay, 'rsvp:' || e.id || ':' || m, now());
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.enqueue_event_notifications(uuid)
  from public, anon, authenticated;

-- ── 4. register a release, and drain what is due ───────────────────────
-- Re-registering re-arms the row on purpose: the dedupe index on
-- org_notifications collapses anyone already told, so republishing after
-- widening the audience reaches the people who were just added and nobody
-- twice.
create or replace function public.register_notification_release(
  p_kind text, p_subject uuid, p_org uuid, p_when timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notification_releases (subject_kind, subject_id, org_id, release_at)
  values (p_kind, p_subject, p_org, coalesce(p_when, now()))
  on conflict (subject_kind, subject_id) do update
     set release_at = excluded.release_at, released_at = null;
end $$;
revoke execute on function public.register_notification_release(text, uuid, uuid, timestamptz)
  from public, anon, authenticated;

-- p_org null drains EVERY workspace: that is the pg_cron sweep and the
-- worker's batch, neither of which belongs to a tenant. publish_post() and
-- publish_event() pass their own org instead, so a director publishing an
-- announcement does release work for their own workspace and for nobody
-- else's. Nothing ever crossed the boundary when this was global — the
-- ledger is RLS-dark and each enqueue resolves its own audience — so this is
-- fairness and cost, not confidentiality: one busy organization should not
-- spend a quiet one's publish latency draining its backlog.
--
-- Deliberately ONE function with a defaulted argument and not a pair:
-- PostgreSQL cannot resolve release_due_notifications() when a zero-argument
-- function and a defaulted one-argument function both exist, so the old
-- zero-argument signature is dropped rather than kept alongside.
drop function if exists public.release_due_notifications();
create or replace function public.release_due_notifications(p_org uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select subject_kind, subject_id from public.notification_releases
     where released_at is null and release_at <= now()
       and (p_org is null or org_id = p_org)
     order by release_at
     for update skip locked
  loop
    if r.subject_kind = 'post' then
      perform public.enqueue_post_notifications(r.subject_id);
    else
      perform public.enqueue_event_notifications(r.subject_id);
    end if;
    update public.notification_releases set released_at = now()
     where subject_kind = r.subject_kind and subject_id = r.subject_id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.release_due_notifications(uuid)
  from public, anon, authenticated;
grant execute on function public.release_due_notifications(uuid) to service_role;

-- ── 5. the client-facing publication step ──────────────────────────────
-- Called by docs/ensemble/feed.html once the post_targets rows exist. It is
-- idempotent, and it flushes anything else in THIS workspace that has come
-- due while it is here — which is what makes a scheduled announcement go out
-- even on a project where pg_cron is unavailable and the worker is idle.
create or replace function public.publish_post(p_post uuid)
returns int language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select id, org_id, publish_at, requires_ack, archived
    into p from public.posts where id = p_post;
  if not found then raise exception 'post_not_found'; end if;
  if not public.can_edit_post(p_post) then raise exception 'not_permitted'; end if;
  if p.requires_ack is not true or p.archived is true then return 0; end if;

  -- a post scheduled for next week becomes due then, not now
  perform public.register_notification_release('post', p.id, p.org_id, p.publish_at);
  perform public.release_due_notifications(p.org_id);   -- this workspace only
  return (select count(*)::int from public.org_notifications
           where channel = 'inapp' and dedupe_key like 'ack:' || p.id || ':%');
end $$;
revoke execute on function public.publish_post(uuid) from public, anon;
grant execute on function public.publish_post(uuid) to authenticated;

-- Called by docs/ensemble/calendar.html after an edit, whose targets are
-- rewritten in requests of their own (docs/ensemble/ops.js).
create or replace function public.publish_event(p_event uuid)
returns int language plpgsql security definer set search_path = public as $$
declare e record;
begin
  select id, org_id, rsvp_required into e from public.org_events where id = p_event;
  if not found then raise exception 'event_not_found'; end if;
  if not public.can_manage_event(p_event) then raise exception 'not_permitted'; end if;
  if e.rsvp_required is not true then return 0; end if;

  perform public.register_notification_release('event', e.id, e.org_id, now());
  perform public.release_due_notifications(e.org_id);   -- this workspace only
  return (select count(*)::int from public.org_notifications
           where channel = 'inapp' and dedupe_key like 'rsvp:' || e.id || ':%');
end $$;
revoke execute on function public.publish_event(uuid) from public, anon;
grant execute on function public.publish_event(uuid) to authenticated;

-- ── 6. retire the INSERT-time post trigger ─────────────────────────────
-- Nothing replaces it: a post notifies when it is published, and only then.
drop trigger if exists posts_notify_ack on public.posts;
drop function if exists public.notify_ack_post();

-- ── 7. the event trigger, deferred to COMMIT ───────────────────────────
create or replace function public.notify_rsvp_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.rsvp_required is not true then return new; end if;
  if tg_op = 'UPDATE' and old.rsvp_required is true then return new; end if;

  if tg_op = 'INSERT' then
    -- deferred to COMMIT, so the targets org_event_create() writes in this
    -- same transaction are already visible: the audience is exact
    perform public.enqueue_event_notifications(new.id);
  else
    -- an edit that turns RSVP on rewrites its targets in a SEPARATE request,
    -- so hold the release until they have landed. calendar.html calls
    -- publish_event() the moment they have; otherwise the sweep picks it up.
    perform public.register_notification_release('event', new.id, new.org_id,
                                                 now() + interval '2 minutes');
  end if;
  return new;
end $$;
revoke execute on function public.notify_rsvp_event() from public, anon, authenticated;

drop trigger if exists org_events_notify_rsvp on public.org_events;
create constraint trigger org_events_notify_rsvp
  after insert or update on public.org_events
  deferrable initially deferred
  for each row execute function public.notify_rsvp_event();

-- ── 8. the worker releases before it claims ────────────────────────────
-- Identical to 0014's body but for the first line, so a scheduled
-- announcement is enqueued by whatever polls the queue next. CREATE OR
-- REPLACE keeps the existing grants (revoked from every browser role).
create or replace function public.claim_notifications(p_limit int default 50)
returns setof public.org_notifications language plpgsql security definer set search_path = public as $$
begin
  perform public.release_due_notifications();
  return query
    update public.org_notifications n set attempts = attempts + 1
     where n.id in (
       select id from public.org_notifications
        where status = 'pending' and scheduled_at <= now()
        order by scheduled_at
        for update skip locked
        limit greatest(1, least(p_limit, 200)))
    returning n.*;
end $$;
-- CREATE OR REPLACE preserves the grants a function already has, and a stock
-- Supabase project hands service_role EXECUTE through a default privilege —
-- which is why the worker keeps draining the queue in production without
-- this line. Say it anyway. The house style is explicit grants (0018, and
-- release_due_notifications above); a scratch database, a self-hosted
-- restore or a project whose default privileges were tightened has no such
-- gift; and leaning on an implicit default for the queue drain is precisely
-- the drift 0012 had to repair across fifteen functions.
grant execute on function public.claim_notifications(int) to service_role;

-- ── 9. the Trial card promises 5 GB; the column handed out 1 GiB ───────
alter table public.organizations
  alter column storage_quota_bytes set default 5368709120;   -- 5 GiB

-- A default only reaches workspaces created from here on. Lift any existing
-- one still sitting on 0005's 1 GiB while on the free trial — the same
-- shortfall, just already handed out. Guarded on the exact old value and on
-- the trial plan, so a quota somebody chose (0015 padmin_set_plan gives paid
-- plans 10/25/50 GiB) is never overwritten and a re-run is a no-op.
--
-- organizations_guard_billing (0005, replaced by 0012) refuses quota writes
-- from 'authenticated' and 'anon' so no org admin can PATCH themselves more
-- storage. A migration runs as the schema owner, not as a browser role, so
-- this UPDATE passes the guard as written — nothing is disabled, spoofed or
-- worked around, and the guard is still refusing directors on the other side
-- of it (see the 0C checks in scripts/test_db_security.py).
update public.organizations
   set storage_quota_bytes = 5368709120
 where storage_quota_bytes = 1073741824
   and plan = 'trial';

comment on column public.organizations.storage_quota_bytes is
  '5 GiB by default — the storage the Trial plan advertises in '
  'docs/ensemble/core.js PLANS. 0005 defaulted to 1 GiB, which quietly '
  'undersold every new workspace; 0019 raised the default and lifted any '
  'trial workspace still holding that old value. Paid plans set their own '
  'quota (0015 padmin_set_plan), which nothing here overwrites.';

-- ── 10. schedule the release sweep, where the platform allows ──────────
-- Guarded exactly like 0017's storage block and 0018's tail: this file also
-- rides inside the single-transaction RUN_ALL / RUN_ENSEMBLE bundles, and
-- pg_cron is a hosted-platform privilege a scratch database or a restricted
-- SQL role will not have. Where it fails, releases still happen — every
-- publish_post() call drains what is due in its own workspace and every
-- claim_notifications() batch drains every workspace — this just makes a
-- scheduled announcement punctual to the minute in a silent organization.
do $$
begin
  execute 'create extension if not exists pg_cron';
  perform cron.schedule('cadence-notification-release', '* * * * *',
                        'select public.release_due_notifications()');
  raise notice 'Cadence: notification release sweep scheduled each minute (pg_cron).';
exception
  when others then
    raise notice 'Cadence: could not schedule the notification release with pg_cron (%). Scheduled announcements then go out at the next publish or the next worker batch, both of which call release_due_notifications().', sqlerrm;
end $$;
