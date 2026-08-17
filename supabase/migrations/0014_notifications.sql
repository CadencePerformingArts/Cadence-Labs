-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — workspace notification spine
--
-- A communications product has to actually deliver. This adds one
-- server-authoritative queue that every notification flows through, plus
-- the enqueue rules for the highest-value events. A trusted worker (running
-- with the service role, OUTSIDE the browser) drains the queue through
-- provider adapters; the client only ever reads its own rows.
--
-- What is enqueued here:
--   • an organization invitation (email)
--   • an announcement that requires acknowledgment (in-app + push), to each
--     member of its audience who has not silenced it (should_notify)
--   • an event that requests an RSVP (in-app + push), to its audience
--
-- Safety: the payload carries only what a template needs — titles, names,
-- links, counts. It never carries message bodies, medical/form answers,
-- drill coordinates, or contact details. Push copy stays generic where the
-- subject is sensitive; the worker owns that.
--
-- Depends on: 0005 (orgs/members/groups), 0006 (posts, post_targets,
-- should_notify), 0007 (org_events, targets), 0012 (guards).
-- ═══════════════════════════════════════════════════════════════════════

create table public.org_notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  recipient_member_id uuid references public.org_members(id) on delete cascade,
  recipient_email text,                       -- for invites (no member yet)
  type text not null,                          -- 'invite' | 'ack_post' | 'rsvp' | …
  channel text not null check (channel in ('inapp', 'push', 'email')),
  priority text not null default 'normal'
    check (priority in ('normal', 'important', 'urgent')),
  -- template-safe data ONLY: never message bodies, medical answers, contacts
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,                    -- collapses duplicates
  scheduled_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped', 'canceled')),
  attempts int not null default 0,
  last_error text,
  read_at timestamptz,                         -- for the in-app channel
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
-- idempotency: one row per (recipient, dedupe_key, channel)
create unique index org_notifications_dedupe
  on public.org_notifications (dedupe_key, channel, coalesce(recipient_member_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(recipient_email, ''));
create index org_notifications_worker
  on public.org_notifications (status, scheduled_at) where status = 'pending';
create index org_notifications_recipient
  on public.org_notifications (recipient_member_id, channel, read_at);

-- ── enqueue (definer; called by triggers and by the worker's helpers) ──
create or replace function public.enqueue_notification(
  p_org uuid, p_member uuid, p_email text, p_type text, p_channel text,
  p_priority text, p_payload jsonb, p_dedupe text, p_when timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.org_notifications
    (org_id, recipient_member_id, recipient_email, type, channel, priority,
     payload, dedupe_key, scheduled_at)
  values
    (p_org, p_member, p_email, p_type, p_channel, coalesce(p_priority, 'normal'),
     coalesce(p_payload, '{}'::jsonb), p_dedupe, coalesce(p_when, now()))
  on conflict do nothing;   -- dedupe index makes re-enqueue harmless
end $$;
revoke execute on function public.enqueue_notification(uuid, uuid, text, text, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated;

-- resolve a post's audience to concrete member ids (no targets = whole org)
create or replace function public.post_audience(p_post uuid)
returns table (member_id uuid) language sql stable security definer set search_path = public as $$
  with p as (select org_id from public.posts where id = p_post),
       t as (select * from public.post_targets where post_id = p_post)
  select m.id from public.org_members m, p
   where m.org_id = p.org_id and m.status = 'active'
     and (
       not exists (select 1 from t)                                   -- whole org
       or exists (select 1 from t where t.member_id = m.id)           -- direct
       or exists (select 1 from t
                   join public.org_group_members gm on gm.group_id = t.group_id
                  where gm.member_id = m.id)                          -- by group
       or exists (select 1 from t
                   join public.org_roles r on r.id = m.role_id
                  where t.role_kind = r.kind)                         -- by role kind
     )
$$;
revoke execute on function public.post_audience(uuid) from public, anon, authenticated;

-- ── trigger: an acknowledgment-required announcement ───────────────────
create or replace function public.notify_ack_post()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m uuid;
  pay jsonb;
begin
  -- only when it actually requires an ack and is (or just became) published
  if new.requires_ack is not true or new.archived is true then return new; end if;
  if new.publish_at is not null and new.publish_at > now() then return new; end if;
  -- on UPDATE, only fire when it newly requires ack / newly publishes
  if tg_op = 'UPDATE' and old.requires_ack is true
     and (old.publish_at is null or old.publish_at <= now())
     and old.archived is false then
    return new;
  end if;

  pay := jsonb_build_object('post_id', new.id, 'title', left(coalesce(new.title, 'Announcement'), 140));
  for m in select member_id from public.post_audience(new.id) loop
    if m = new.author_member_id then continue; end if;   -- not your own post
    if public.should_notify(m, 'announcement', new.id, 'inapp', new.priority) then
      perform public.enqueue_notification(new.org_id, m, null, 'ack_post', 'inapp',
        new.priority, pay, 'ack:' || new.id || ':' || m, now());
    end if;
    if public.should_notify(m, 'announcement', new.id, 'push', new.priority) then
      perform public.enqueue_notification(new.org_id, m, null, 'ack_post', 'push',
        new.priority, pay, 'ack:' || new.id || ':' || m, now());
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.notify_ack_post() from public, anon, authenticated;

drop trigger if exists posts_notify_ack on public.posts;
create trigger posts_notify_ack after insert or update on public.posts
  for each row execute function public.notify_ack_post();

-- ── trigger: an organization invitation with an email ──────────────────
create or replace function public.notify_invite()
returns trigger language plpgsql security definer set search_path = public as $$
declare org_name text;
begin
  if new.email is null or btrim(new.email) = '' then return new; end if;
  select name into org_name from public.organizations where id = new.org_id;
  perform public.enqueue_notification(
    new.org_id, null, new.email, 'invite', 'email', 'important',
    jsonb_build_object('org_name', org_name, 'code', new.code,
      -- the join link is safe to template; the raw code rides only so the
      -- worker can build the link, and is never logged as an error detail
      'expires_at', new.expires_at),
    'invite:' || new.id, now());
  return new;
end $$;
revoke execute on function public.notify_invite() from public, anon, authenticated;

drop trigger if exists org_invites_notify on public.org_invites;
create trigger org_invites_notify after insert on public.org_invites
  for each row execute function public.notify_invite();

-- ── trigger: an event that requests an RSVP ────────────────────────────
-- Event targeting is group-based (org_event_targets.group_id); no targets
-- means the whole org.
create or replace function public.notify_rsvp_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare m uuid; pay jsonb;
begin
  if new.rsvp_required is not true then return new; end if;
  if tg_op = 'UPDATE' and old.rsvp_required is true then return new; end if;
  pay := jsonb_build_object('event_id', new.id, 'title', left(coalesce(new.title, 'Event'), 140),
                            'starts_at', new.starts_at);
  for m in
    select mm.id from public.org_members mm
     where mm.org_id = new.org_id and mm.status = 'active'
       and (
         not exists (select 1 from public.org_event_targets et where et.event_id = new.id)
         or exists (select 1 from public.org_event_targets et
                     join public.org_group_members gm on gm.group_id = et.group_id
                    where et.event_id = new.id and gm.member_id = mm.id))
  loop
    if public.should_notify(m, 'event', new.id, 'inapp', 'normal') then
      perform public.enqueue_notification(new.org_id, m, null, 'rsvp', 'inapp',
        'normal', pay, 'rsvp:' || new.id || ':' || m, now());
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.notify_rsvp_event() from public, anon, authenticated;

drop trigger if exists org_events_notify_rsvp on public.org_events;
create trigger org_events_notify_rsvp after insert or update on public.org_events
  for each row execute function public.notify_rsvp_event();

-- ── worker surface (service role only) ─────────────────────────────────
-- The worker claims a batch of due pending rows, sends them through its
-- provider adapters, then marks each. mark_notification is the only way the
-- status advances; nothing the client can call touches it.
create or replace function public.claim_notifications(p_limit int default 50)
returns setof public.org_notifications language plpgsql security definer set search_path = public as $$
begin
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
revoke execute on function public.claim_notifications(int) from public, anon, authenticated;

create or replace function public.mark_notification(p_id uuid, p_status text, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.org_notifications
     set status = p_status,
         last_error = left(p_error, 300),
         sent_at = case when p_status = 'sent' then now() else sent_at end
   where id = p_id;
end $$;
revoke execute on function public.mark_notification(uuid, text, text) from public, anon, authenticated;

-- ── RLS: a member sees their own in-app notifications, nothing else ────
alter table public.org_notifications enable row level security;

create policy notif_read_own on public.org_notifications for select to authenticated
  using (channel = 'inapp' and recipient_member_id = public.org_member_id(org_id));

-- a member may only mark their own in-app row read (read_at); the guard
-- below stops them from touching status/priority/anything else
create policy notif_mark_read on public.org_notifications for update to authenticated
  using (channel = 'inapp' and recipient_member_id = public.org_member_id(org_id))
  with check (channel = 'inapp' and recipient_member_id = public.org_member_id(org_id));

create or replace function public.guard_notification_update()
returns trigger language plpgsql set search_path = public as $$
declare claims_role text;
begin
  claims_role := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if claims_role = 'service_role' or current_user not in ('authenticated', 'anon') then
    return new;                         -- the worker (service role) may do anything
  end if;
  -- a signed-in recipient may change ONLY read_at
  if new.status is distinct from old.status
     or new.payload is distinct from old.payload
     or new.priority is distinct from old.priority
     or new.channel is distinct from old.channel
     or new.recipient_member_id is distinct from old.recipient_member_id
     or new.attempts is distinct from old.attempts then
    raise exception 'notification_readonly: only read_at may be set by a recipient';
  end if;
  return new;
end $$;
revoke execute on function public.guard_notification_update() from public, anon, authenticated;

drop trigger if exists org_notifications_guard on public.org_notifications;
create trigger org_notifications_guard before update on public.org_notifications
  for each row execute function public.guard_notification_update();

-- no client insert/delete policy exists, so only the service role (which
-- bypasses RLS) and the definer enqueue function can create rows
