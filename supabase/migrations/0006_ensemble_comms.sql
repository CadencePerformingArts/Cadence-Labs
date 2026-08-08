-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — communication (Phase 2)
--
-- Everything an organization says to itself:
--   • posts  — the feed. Announcements and ordinary posts, with priority,
--     targeting (whole org / groups / role kinds / named individuals),
--     pinning, scheduled publishing, required acknowledgment, comments,
--     reactions and read receipts.
--   • chats  — org-wide, per-group, staff-only, event and direct messages,
--     with replies, reactions, edit/soft-delete, pinning, and a moderation
--     report queue that leaves a trail.
--   • org_notification_prefs — per-member delivery levels, with the one
--     rule the product will not bend on: URGENT ALWAYS DELIVERS.
--
-- Visibility is computed SERVER-SIDE. The browser never decides who may
-- read a post: can_see_post() does, and every dependent table (comments,
-- reactions, acks, reads, targets) cascades off it. Youth-safety switches
-- in organizations.settings (student_dms, student_staff_dms,
-- member_created_chats) are enforced by RLS, not by hiding buttons.
--
-- ─── Owner notes ───────────────────────────────────────────────────────
--  • Run once in the Supabase SQL editor, after 0005_ensemble_core.sql.
--  • Depends on 0005 helpers: is_org_member, org_has_perm, org_writable,
--    org_can_write, org_member_id, is_group_member; and on 0001's
--    touch_updated_at().
--  • The tail of this file adds messages/posts/comments/reactions to the
--    `supabase_realtime` publication. The Feed and Messages screens use
--    Realtime, not polling — if you skip that block, both pages still work
--    but stop updating live.
--  • public.org_plan_has() mirrors the plan→feature matrix in
--    docs/ensemble/core.js. It is intentionally generic so later feature
--    migrations can reuse it; keep the two in sync if plans change.
--  • Nothing here is destructive. Posts archive, messages soft-delete
--    (deleted_at) — history is preserved for the life of the workspace.
-- ═══════════════════════════════════════════════════════════════════════

-- ═══ plan/entitlement helper (mirrors PLANS + PRO_FEATURES in core.js) ═══
create or replace function public.org_plan_has(p_org uuid, p_feature text)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when o.plan in ('trial', 'pro', 'program') then true
    when o.plan = 'ensemble' then p_feature not in (
      'staff_workspace', 'itineraries', 'packing_lists', 'assignments',
      'submissions', 'equipment', 'uniforms', 'auditions',
      'advanced_permissions', 'advanced_reporting', 'acknowledgments',
      'volunteer_management', 'automation')
    else false
  end
  from public.organizations o where o.id = p_org
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- POSTS — the feed
-- ═══════════════════════════════════════════════════════════════════════

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  author_member_id uuid references public.org_members(id) on delete set null,
  kind text not null default 'post'
    check (kind in ('post', 'announcement')),
  priority text not null default 'normal'
    check (priority in ('normal', 'important', 'urgent')),
  title text,
  body text not null default '',
  attachments jsonb not null default '[]',
  pinned boolean not null default false,
  requires_ack boolean not null default false,
  publish_at timestamptz not null default now(),   -- future = scheduled
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index posts_org_idx on public.posts (org_id, archived, pinned desc, publish_at desc);
create index posts_author_idx on public.posts (author_member_id);

-- Targeting. ZERO rows for a post = org-wide. Otherwise the post is visible
-- to members matching ANY row (group membership OR role kind OR named member).
create table public.post_targets (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  group_id uuid references public.org_groups(id) on delete cascade,
  role_kind text
    check (role_kind is null or role_kind in ('owner', 'staff', 'leadership',
           'member', 'parent', 'booster', 'volunteer', 'alumni', 'guest')),
  member_id uuid references public.org_members(id) on delete cascade,
  constraint post_targets_one_dimension check (
    (group_id is not null)::int + (role_kind is not null)::int
      + (member_id is not null)::int = 1
  )
);
create index post_targets_post_idx on public.post_targets (post_id);
create index post_targets_group_idx on public.post_targets (group_id);
create index post_targets_member_idx on public.post_targets (member_id);

-- "187 of 204 acknowledged"
create table public.post_acks (
  post_id uuid not null references public.posts(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  acked_at timestamptz not null default now(),
  primary key (post_id, member_id)
);
create index post_acks_member_idx on public.post_acks (member_id);

create table public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  member_id uuid references public.org_members(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index post_comments_post_idx on public.post_comments (post_id, created_at);

create table public.post_reactions (
  post_id uuid not null references public.posts(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, member_id, emoji)
);

create table public.post_reads (
  post_id uuid not null references public.posts(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (post_id, member_id)
);

create trigger posts_touch before update on public.posts
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- CHATS — conversations
-- ═══════════════════════════════════════════════════════════════════════

create table public.chats (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null default 'group'
    check (kind in ('org', 'group', 'staff', 'dm', 'event')),
  group_id uuid references public.org_groups(id) on delete set null,
  title text,
  created_by_member uuid references public.org_members(id) on delete set null,
  is_moderated boolean not null default true,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index chats_org_idx on public.chats (org_id, kind);
create unique index chats_one_org_wide on public.chats (org_id) where kind = 'org';

create table public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  last_read_at timestamptz,
  muted boolean not null default false,
  added_at timestamptz not null default now(),
  primary key (chat_id, member_id)
);
create index chat_members_member_idx on public.chat_members (member_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  member_id uuid references public.org_members(id) on delete set null,
  body text not null default '',
  attachments jsonb not null default '[]',
  reply_to uuid references public.messages(id) on delete set null,
  pinned boolean not null default false,   -- pinned messages, per screen spec
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index messages_chat_idx on public.messages (chat_id, created_at desc);
create index messages_pinned_idx on public.messages (chat_id) where pinned;

create table public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, member_id, emoji)
);

-- moderation trail: reports are never deleted, only resolved
create table public.message_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  reporter_member_id uuid references public.org_members(id) on delete set null,
  reason text,
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'actioned', 'dismissed')),
  resolved_by_member uuid references public.org_members(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index message_reports_msg_idx on public.message_reports (message_id);

-- ═══════════════════════════════════════════════════════════════════════
-- NOTIFICATION PREFERENCES
--   scope_id is the org / group / chat id the preference applies to, so the
--   composite primary key needs no nullable column.
--   'none' silences everything EXCEPT urgent announcements — enforced by
--   should_notify() below, which every delivery path must call.
-- ═══════════════════════════════════════════════════════════════════════

create table public.org_notification_prefs (
  member_id uuid not null references public.org_members(id) on delete cascade,
  scope text not null check (scope in ('org', 'group', 'chat')),
  scope_id uuid not null,
  channel text not null check (channel in ('push', 'email')),
  level text not null default 'all'
    check (level in ('all', 'important', 'urgent', 'none')),
  updated_at timestamptz not null default now(),
  primary key (member_id, scope, scope_id, channel)
);

comment on column public.org_notification_prefs.level is
  'all | important | urgent | none. "none" never suppresses priority=urgent '
  'announcements — see public.should_notify().';

-- ═══════════════════════════════════════════════════════════════════════
-- HELPERS (SECURITY DEFINER so policies never recurse into RLS)
-- ═══════════════════════════════════════════════════════════════════════

-- THE visibility rule for the feed. True when the caller is an active member
-- of the post's org AND the post is untargeted (org-wide) or the caller
-- matches at least one target row by group, role kind, or member id.
create or replace function public.can_see_post(p_post uuid)
returns boolean language sql security definer stable set search_path = public as $$
  with p as (
    select id, org_id from public.posts where id = p_post
  ), me as (
    select m.id, m.role_id
      from public.org_members m join p on p.org_id = m.org_id
     where m.user_id = auth.uid() and m.status = 'active'
     limit 1
  )
  select exists (select 1 from me)
     and (
       not exists (select 1 from public.post_targets t where t.post_id = p_post)
       or exists (
         select 1 from public.post_targets t cross join me
          where t.post_id = p_post
            and (
              (t.member_id is not null and t.member_id = me.id)
              or (t.group_id is not null and exists (
                    select 1 from public.org_group_members gm
                     where gm.group_id = t.group_id and gm.member_id = me.id))
              or (t.role_kind is not null and exists (
                    select 1 from public.org_roles r
                     where r.id = me.role_id and r.kind = t.role_kind))
            )
       )
     )
$$;

-- may the caller edit/administer this post? (author, or announce.edit)
create or replace function public.can_edit_post(p_post uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.posts p
     where p.id = p_post
       and (p.author_member_id = public.org_member_id(p.org_id)
            or public.org_has_perm(p.org_id, 'announce.edit'))
  )
$$;

-- my org_members.id in the org that owns this post (null if not a member)
create or replace function public.post_member_id(p_post uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select public.org_member_id((select org_id from public.posts where id = p_post))
$$;

create or replace function public.post_org(p_post uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select org_id from public.posts where id = p_post
$$;

create or replace function public.chat_org(p_chat uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select org_id from public.chats where id = p_chat
$$;

-- did I open this room, or do I moderate it? (SECURITY DEFINER on purpose:
-- policies must not have to SELECT chats through chats' own RLS, or a fresh
-- DM would be unreachable by the person who just created it.)
create or replace function public.chat_creator_or_mod(p_chat uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.chats c
     where c.id = p_chat
       and (c.created_by_member = public.org_member_id(c.org_id)
            or public.org_has_perm(c.org_id, 'chat.moderate'))
  )
$$;

create or replace function public.chat_member_id(p_chat uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select public.org_member_id(public.chat_org(p_chat))
$$;

create or replace function public.is_chat_member(p_chat uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.chat_members cm
      join public.org_members m on m.id = cm.member_id
     where cm.chat_id = p_chat and m.user_id = auth.uid() and m.status = 'active'
  )
$$;

-- staff-ish role kinds get the adult side of the youth-safety rules
create or replace function public.member_is_staff(p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_members m join public.org_roles r on r.id = m.role_id
     where m.id = p_member and r.kind in ('owner', 'staff')
  )
$$;

-- ── youth safety: may these two members hold a private conversation?
--    If neither is a minor, yes. If either is:
--      minor ↔ minor  → organizations.settings.student_dms
--      minor ↔ staff  → organizations.settings.student_staff_dms
--    A parent/booster/volunteer counts as "not staff" here on purpose:
--    only role kinds owner/staff are treated as supervised adults.
create or replace function public.pair_may_dm(p_a uuid, p_b uuid)
returns boolean language sql security definer stable set search_path = public as $$
  with a as (select org_id, is_minor from public.org_members where id = p_a),
       b as (select org_id, is_minor from public.org_members where id = p_b),
       s as (select o.settings from public.organizations o
              join a on a.org_id = o.id)
  select case
    when not exists (select 1 from a) or not exists (select 1 from b) then false
    when (select org_id from a) is distinct from (select org_id from b) then false
    when p_a = p_b then true
    when not ((select is_minor from a) or (select is_minor from b)) then true
    when public.member_is_staff(p_a) and public.member_is_staff(p_b) then true
    when public.member_is_staff(p_a) or public.member_is_staff(p_b)
      then coalesce(((select settings from s) ->> 'student_staff_dms')::boolean, false)
    else coalesce(((select settings from s) ->> 'student_dms')::boolean, false)
  end
$$;

-- may this member be added to this chat under the youth-safety rules?
-- Non-DM chats are always fine; a DM must pass pair_may_dm() against every
-- member already in it.
create or replace function public.dm_allowed(p_chat uuid, p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when (select kind from public.chats where id = p_chat) is distinct from 'dm' then true
    else not exists (
      select 1 from public.chat_members cm
       where cm.chat_id = p_chat and cm.member_id <> p_member
         and not public.pair_may_dm(cm.member_id, p_member))
  end
$$;

-- may the caller start a chat here at all? (chat.create, or the org has
-- opted members into creating their own chats)
create or replace function public.may_create_chat(p_org uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.org_writable(p_org)
     and (
       public.org_has_perm(p_org, 'chat.create')
       or (public.is_org_member(p_org) and coalesce(
             (select (o.settings ->> 'member_created_chats')::boolean
                from public.organizations o where o.id = p_org), false))
     )
$$;

-- an open chat is one an ordinary member may join themselves
create or replace function public.chat_is_open(p_chat uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.chats c
     where c.id = p_chat
       and public.is_org_member(c.org_id)
       and (c.kind = 'org'
            or (c.kind = 'group' and c.group_id is not null
                and public.is_group_member(c.group_id))
            or (c.kind = 'staff' and public.org_has_perm(c.org_id, 'staff.access')))
  )
$$;

-- ── the one rule notifications must obey. Delivery code calls this instead
--    of reading `level` directly: urgent announcements always get through.
create or replace function public.should_notify(
  p_member uuid, p_scope text, p_scope_id uuid, p_channel text, p_priority text)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when p_priority = 'urgent' then true            -- never silenceable
    else case coalesce((
      select level from public.org_notification_prefs
       where member_id = p_member and scope = p_scope
         and scope_id = p_scope_id and channel = p_channel), 'all')
      when 'none' then false
      when 'urgent' then false                       -- urgent handled above
      when 'important' then p_priority in ('important', 'urgent')
      else true
    end
  end
$$;

revoke execute on function public.org_plan_has(uuid, text) from public, anon;
revoke execute on function public.can_see_post(uuid) from public, anon;
revoke execute on function public.can_edit_post(uuid) from public, anon;
revoke execute on function public.post_member_id(uuid) from public, anon;
revoke execute on function public.post_org(uuid) from public, anon;
revoke execute on function public.chat_org(uuid) from public, anon;
revoke execute on function public.chat_creator_or_mod(uuid) from public, anon;
revoke execute on function public.chat_member_id(uuid) from public, anon;
revoke execute on function public.is_chat_member(uuid) from public, anon;
revoke execute on function public.member_is_staff(uuid) from public, anon;
revoke execute on function public.pair_may_dm(uuid, uuid) from public, anon;
revoke execute on function public.dm_allowed(uuid, uuid) from public, anon;
revoke execute on function public.may_create_chat(uuid) from public, anon;
revoke execute on function public.chat_is_open(uuid) from public, anon;
revoke execute on function public.should_notify(uuid, text, uuid, text, text) from public, anon;

-- ═══════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════
alter table public.posts enable row level security;
alter table public.post_targets enable row level security;
alter table public.post_acks enable row level security;
alter table public.post_comments enable row level security;
alter table public.post_reactions enable row level security;
alter table public.post_reads enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.message_reports enable row level security;
alter table public.org_notification_prefs enable row level security;

-- ── posts ──────────────────────────────────────────────────────────────
-- read: targeting decides, and scheduled posts stay hidden until publish_at.
-- Authors and announcement editors always see their own drafts/schedules.
create policy posts_read on public.posts for select to authenticated
  using (
    (public.can_see_post(id) and publish_at <= now())
    or author_member_id = public.org_member_id(org_id)
    or public.org_has_perm(org_id, 'announce.edit')
  );

create policy posts_insert on public.posts for insert to authenticated
  with check (
    public.org_can_write(org_id, 'announce.create')
    and author_member_id = public.org_member_id(org_id)
    and (priority <> 'urgent' or public.org_has_perm(org_id, 'announce.urgent'))
    and (requires_ack = false or public.org_plan_has(org_id, 'acknowledgments'))
  );

-- authors may always edit their own; editing anyone else's needs announce.edit
create policy posts_update on public.posts for update to authenticated
  using (
    public.org_writable(org_id)
    and (author_member_id = public.org_member_id(org_id)
         or public.org_has_perm(org_id, 'announce.edit'))
  )
  with check (
    public.org_writable(org_id)
    and (author_member_id = public.org_member_id(org_id)
         or public.org_has_perm(org_id, 'announce.edit'))
    and (priority <> 'urgent' or public.org_has_perm(org_id, 'announce.urgent'))
    and (requires_ack = false or public.org_plan_has(org_id, 'acknowledgments'))
  );

-- deletion is a last resort; the product archives. announce.edit only.
create policy posts_delete on public.posts for delete to authenticated
  using (public.org_can_write(org_id, 'announce.edit'));

-- ── post_targets ───────────────────────────────────────────────────────
create policy ptargets_read on public.post_targets for select to authenticated
  using (public.can_see_post(post_id) or public.can_edit_post(post_id));
create policy ptargets_write on public.post_targets for all to authenticated
  using (public.can_edit_post(post_id)) with check (public.can_edit_post(post_id));

-- ── acknowledgments ────────────────────────────────────────────────────
-- Everyone who can see a post can see its ack roll — that is the point of a
-- required acknowledgment: "who has read this" is not a secret from the room.
create policy acks_read on public.post_acks for select to authenticated
  using (public.can_see_post(post_id) or public.can_edit_post(post_id));
create policy acks_insert on public.post_acks for insert to authenticated
  with check (public.can_see_post(post_id) and member_id = public.post_member_id(post_id));
create policy acks_delete on public.post_acks for delete to authenticated
  using (member_id = public.post_member_id(post_id));

-- ── comments ───────────────────────────────────────────────────────────
create policy pcomments_read on public.post_comments for select to authenticated
  using (public.can_see_post(post_id) or public.can_edit_post(post_id));
create policy pcomments_insert on public.post_comments for insert to authenticated
  with check (
    public.can_see_post(post_id)
    and member_id = public.post_member_id(post_id)
    and public.org_writable(public.post_org(post_id))
  );
create policy pcomments_update on public.post_comments for update to authenticated
  using (member_id = public.post_member_id(post_id) or public.can_edit_post(post_id))
  with check (member_id = public.post_member_id(post_id) or public.can_edit_post(post_id));
create policy pcomments_delete on public.post_comments for delete to authenticated
  using (member_id = public.post_member_id(post_id) or public.can_edit_post(post_id));

-- ── reactions & reads ──────────────────────────────────────────────────
create policy preactions_read on public.post_reactions for select to authenticated
  using (public.can_see_post(post_id) or public.can_edit_post(post_id));
create policy preactions_write on public.post_reactions for all to authenticated
  using (member_id = public.post_member_id(post_id))
  with check (public.can_see_post(post_id) and member_id = public.post_member_id(post_id));

create policy preads_read on public.post_reads for select to authenticated
  using (member_id = public.post_member_id(post_id) or public.can_edit_post(post_id));
create policy preads_write on public.post_reads for all to authenticated
  using (member_id = public.post_member_id(post_id))
  with check (public.can_see_post(post_id) and member_id = public.post_member_id(post_id));

-- ── chats ──────────────────────────────────────────────────────────────
-- You see a chat you belong to, an open chat you're eligible to join, or —
-- if you moderate — any chat in the org, so reports can be acted on.
create policy chats_read on public.chats for select to authenticated
  using (
    public.is_chat_member(id)
    or public.chat_is_open(id)
    or created_by_member = public.org_member_id(org_id)   -- your own new DM
    or public.org_has_perm(org_id, 'chat.moderate')
  );

create policy chats_insert on public.chats for insert to authenticated
  with check (
    public.may_create_chat(org_id)
    and created_by_member = public.org_member_id(org_id)
    -- a staff-only room needs staff access; a group room needs the group
    and (kind <> 'staff' or public.org_has_perm(org_id, 'staff.access'))
    and (kind <> 'group' or group_id is null
         or public.is_group_member(group_id)
         or public.org_has_perm(org_id, 'group.manage'))
  );

create policy chats_update on public.chats for update to authenticated
  using (
    public.org_writable(org_id)
    and (created_by_member = public.org_member_id(org_id)
         or public.org_has_perm(org_id, 'chat.moderate'))
  )
  with check (
    created_by_member = public.org_member_id(org_id)
    or public.org_has_perm(org_id, 'chat.moderate')
  );

create policy chats_delete on public.chats for delete to authenticated
  using (public.org_can_write(org_id, 'chat.moderate'));

-- ── chat membership ────────────────────────────────────────────────────
create policy cmembers_read on public.chat_members for select to authenticated
  using (public.is_chat_member(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'));

-- Adding someone: the chat's creator, a moderator, or yourself joining an
-- open room. Every path also has to satisfy the DM rules.
create policy cmembers_insert on public.chat_members for insert to authenticated
  with check (
    public.org_writable(public.chat_org(chat_id))
    and public.dm_allowed(chat_id, member_id)
    and (
      public.chat_creator_or_mod(chat_id)
      or (member_id = public.chat_member_id(chat_id) and public.chat_is_open(chat_id))
    )
  );

-- your own row (last_read_at, muted) is yours; moderators may fix any
create policy cmembers_update on public.chat_members for update to authenticated
  using (member_id = public.chat_member_id(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'))
  with check (member_id = public.chat_member_id(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'));

create policy cmembers_delete on public.chat_members for delete to authenticated
  using (member_id = public.chat_member_id(chat_id)
         or public.chat_creator_or_mod(chat_id));

-- ── messages ───────────────────────────────────────────────────────────
create policy messages_read on public.messages for select to authenticated
  using (public.is_chat_member(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'));

create policy messages_insert on public.messages for insert to authenticated
  with check (
    public.is_chat_member(chat_id)
    and member_id = public.chat_member_id(chat_id)
    and public.org_writable(public.chat_org(chat_id))
  );

-- edit your own; moderators may soft-delete or pin anything
create policy messages_update on public.messages for update to authenticated
  using (
    public.org_writable(public.chat_org(chat_id))
    and (member_id = public.chat_member_id(chat_id)
         or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate'))
  )
  with check (
    member_id = public.chat_member_id(chat_id)
    or public.org_has_perm(public.chat_org(chat_id), 'chat.moderate')
  );

-- hard delete is moderator-only; the UI uses deleted_at so threads stay legible
create policy messages_delete on public.messages for delete to authenticated
  using (public.org_can_write(public.chat_org(chat_id), 'chat.moderate'));

create policy mreactions_read on public.message_reactions for select to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id and public.is_chat_member(m.chat_id)));
create policy mreactions_write on public.message_reactions for all to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id and member_id = public.chat_member_id(m.chat_id)))
  with check (exists (select 1 from public.messages m
                  where m.id = message_id
                    and public.is_chat_member(m.chat_id)
                    and member_id = public.chat_member_id(m.chat_id)));

-- ── reports: reporters see their own, moderators see the queue ─────────
create policy mreports_read on public.message_reports for select to authenticated
  using (
    exists (select 1 from public.messages m
             where m.id = message_id
               and (reporter_member_id = public.chat_member_id(m.chat_id)
                    or public.org_has_perm(public.chat_org(m.chat_id), 'chat.moderate')))
  );
create policy mreports_insert on public.message_reports for insert to authenticated
  with check (
    exists (select 1 from public.messages m
             where m.id = message_id
               and public.is_chat_member(m.chat_id)
               and reporter_member_id = public.chat_member_id(m.chat_id))
  );
create policy mreports_update on public.message_reports for update to authenticated
  using (exists (select 1 from public.messages m
                  where m.id = message_id
                    and public.org_has_perm(public.chat_org(m.chat_id), 'chat.moderate')))
  with check (exists (select 1 from public.messages m
                  where m.id = message_id
                    and public.org_has_perm(public.chat_org(m.chat_id), 'chat.moderate')));

-- ── notification preferences: strictly your own ────────────────────────
create policy notif_own on public.org_notification_prefs for all to authenticated
  using (exists (select 1 from public.org_members m
                  where m.id = member_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.org_members m
                  where m.id = member_id and m.user_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════════
-- REALTIME — the Feed and Messages screens subscribe to postgres_changes.
-- Replica identity full so UPDATE payloads carry the whole row (edits,
-- soft-deletes and pin toggles all arrive as UPDATEs).
-- ═══════════════════════════════════════════════════════════════════════
alter table public.messages replica identity full;
alter table public.posts replica identity full;
alter table public.post_comments replica identity full;
alter table public.post_reactions replica identity full;
alter table public.post_acks replica identity full;
alter table public.message_reactions replica identity full;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['messages', 'posts', 'post_comments',
                             'post_reactions', 'post_acks', 'message_reactions']
    loop
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Owner workflow queries
--
--   -- who still owes an acknowledgment on a post?
--   select m.display_name from org_members m
--    where m.org_id = '…' and m.status = 'active'
--      and m.id not in (select member_id from post_acks where post_id = '…');
--
--   -- open moderation queue for a workspace
--   select r.*, msg.body from message_reports r
--     join messages msg on msg.id = r.message_id
--     join chats c on c.id = msg.chat_id
--    where c.org_id = '…' and r.status = 'open' order by r.created_at;
--
--   -- turn student DMs on for one organization
--   update organizations
--      set settings = settings || '{"student_dms":true}'::jsonb
--    where slug = '…';
--
--   -- create the org-wide chat by hand (the Messages screen also offers this)
--   insert into chats (org_id, kind, title, created_by_member)
--   values ('…', 'org', 'Everyone', '…member id…');
-- ═══════════════════════════════════════════════════════════════════════
