-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — event chat rooms
--
-- The event page has always linked to "Event chat", but the chats table had
-- an 'event' kind with no way to point at an event, so the link opened the
-- plain message list. This adds the missing link and one guarded RPC that
-- finds or creates the room for an event — atomically, so two people
-- tapping the button at once share one room instead of racing two.
--
-- Event chats are structural staff-adjacent spaces: they are moderated and
-- safety-exempt (0012's chat rule), scoped to members who can see the event.
--
-- Depends on: 0006 (chats), 0007 (org_events, can_see_event, event_org),
-- 0012 (chats.safety_exempt).
-- ═══════════════════════════════════════════════════════════════════════

alter table public.chats
  add column if not exists event_id uuid references public.org_events(id) on delete cascade;

-- one chat per event
create unique index if not exists chats_one_per_event
  on public.chats (event_id) where event_id is not null;

create index if not exists chats_event_idx on public.chats (event_id);

-- open (or create) the chat for an event. Returns the chat id.
create or replace function public.open_event_chat(p_event uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_me uuid;
  v_chat uuid;
  v_title text;
begin
  if auth.uid() is null then raise exception 'auth_required'; end if;
  v_org := public.event_org(p_event);
  if v_org is null then raise exception 'no_such_event'; end if;

  -- you must be able to see the event to be in its room
  if not public.can_see_event(p_event) then
    raise exception 'not_allowed: this event is not shared with you';
  end if;
  v_me := public.org_member_id(v_org);
  if v_me is null then raise exception 'not_a_member'; end if;

  -- find-or-create under the unique index; lock so concurrent taps agree
  select id into v_chat from public.chats where event_id = p_event for update;
  if v_chat is null then
    select 'Event · ' || coalesce(title, 'Untitled')
      into v_title from public.org_events where id = p_event;
    insert into public.chats (org_id, kind, event_id, title, created_by_member,
                              is_moderated, safety_exempt)
    values (v_org, 'event', p_event, v_title, v_me, true, true)
    returning id into v_chat;
  end if;

  -- ensure the caller is a participant (idempotent)
  insert into public.chat_members (chat_id, member_id)
  values (v_chat, v_me) on conflict do nothing;

  return v_chat;
end $$;
revoke execute on function public.open_event_chat(uuid) from public, anon;
grant execute on function public.open_event_chat(uuid) to authenticated;
