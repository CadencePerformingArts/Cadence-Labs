-- Ensemble Pro v1 — organizations claim and manage their official profile.
--
-- An approved `claims` row (kind='ensemble') is the key that unlocks writing
-- an `ensemble_profiles` row for that exact (app_key, ensemble_name). Claims
-- themselves are verified by hand — nothing here auto-approves anything.
--
-- ─── Owner: run this file once in the Supabase SQL editor. ───
--
-- Approval workflow (run in SQL editor as needed):
--
--   List pending claims, oldest first:
--     select c.id, c.created_at, c.kind, c.app_key, c.target_name,
--            c.claimant_role, c.message, c.user_id, u.email
--       from public.claims c
--       left join auth.users u on u.id = c.user_id
--      where c.status = 'pending'
--      order by c.created_at;
--
--   Approve a claim (after verifying the person really represents the org —
--   e.g. an email from the ensemble's official domain, or a reply from a
--   published contact address):
--     update public.claims
--        set status = 'approved', reviewed_at = now(),
--            reviewer_note = 'verified via official email'
--      where id = '<claim uuid>';
--
--   Reject a claim:
--     update public.claims
--        set status = 'rejected', reviewed_at = now(),
--            reviewer_note = 'could not verify affiliation'
--      where id = '<claim uuid>';
--
--   See every published ensemble profile:
--     select app_key, ensemble_name, owner_user_id, published, updated_at
--       from public.ensemble_profiles order by app_key, ensemble_name;

-- ---------------------------------------------------------------------------
-- profiles.role — platform roles (plain users vs. the platform admin).
-- Clients can never set this: column-level UPDATE/INSERT on `role` is revoked
-- below, so even though `profiles_own` is FOR ALL, a user writing their own
-- profile row cannot touch `role`. Only the service role / SQL editor can.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists role text not null default 'user'
  constraint profiles_role_check check (role in ('user', 'platform_admin'));

-- Column-level REVOKE cannot carve a column out of a table-wide grant, so drop
-- the table-wide write privileges and re-grant only the client-writable
-- columns. (Adding a client-writable column to profiles later means adding it
-- to these grants too.) SELECT/DELETE stay table-wide; RLS still scopes every
-- operation to the user's own row.
revoke insert, update on public.profiles from anon, authenticated;
grant insert (id, display_name), update (display_name) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- ensemble_profiles — one row per claimed ensemble per app.
--
-- `content` is a single jsonb document owned by the ensemble. Canonical shape
-- (all keys optional; the client renders only what it recognizes):
--   {
--     "description":   text,
--     "show_title":    text,
--     "repertoire":    text,
--     "staff":         [{ "name": text, "role": text }],
--     "website":       url,
--     "socials":       { "instagram"|"facebook"|"x"|"youtube"|"tiktok": url },
--     "auditions":     { "info": text, "link": url },
--     "open_positions":[ text ],
--     "merch_url":     url,
--     "donate_url":    url,
--     "sponsors":      [{ "name": text, "url": url }],
--     "announcements": [{ "ts": iso8601, "title": text, "body": text }],
--     "videos":        [ url ],
--     "alumni":        text,
--     "logo_url":      url,
--     "cover_url":     url
--   }
-- ---------------------------------------------------------------------------

create table public.ensemble_profiles (
  id uuid primary key default gen_random_uuid(),
  app_key text not null,            -- '' (DCI), 'boa', 'wgi/guard', … matches docs/<key>/
  ensemble_name text not null,      -- exactly as in that app's corps_index.json
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  published boolean not null default true,
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_key, ensemble_name)
);

create index ensemble_profiles_owner_idx on public.ensemble_profiles (owner_user_id);

-- keep updated_at honest on every write (helper ships with the claims
-- migration; create or replace keeps this file self-sufficient)
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger ensemble_profiles_touch
  before update on public.ensemble_profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Read: anyone can read published profiles; owners always see their own.
-- Write: only the owner, and only while they hold an approved ensemble claim
-- for that exact (app_key, target_name). Revoking a claim (set status back to
-- 'pending' or 'rejected') instantly freezes the profile without deleting it.
-- ---------------------------------------------------------------------------

-- Security-definer helper so policies stay one readable line. Runs as the
-- table owner (bypasses RLS on claims), pinned search_path, and is granted
-- only to `authenticated` — it is a policy internal, not a public RPC.
create or replace function public.has_approved_ensemble_claim(p_app_key text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.claims c
     where c.user_id = auth.uid()
       and c.kind = 'ensemble'
       and c.app_key = p_app_key
       and c.target_name = p_name
       and c.status = 'approved'
  );
$$;

revoke execute on function public.has_approved_ensemble_claim(text, text) from public, anon;
grant execute on function public.has_approved_ensemble_claim(text, text) to authenticated;

alter table public.ensemble_profiles enable row level security;

create policy ensemble_profiles_public_read on public.ensemble_profiles
  for select to anon, authenticated
  using (published);

create policy ensemble_profiles_owner_read on public.ensemble_profiles
  for select to authenticated
  using (owner_user_id = auth.uid());

create policy ensemble_profiles_owner_insert on public.ensemble_profiles
  for insert to authenticated
  with check (
    owner_user_id = auth.uid()
    and public.has_approved_ensemble_claim(app_key, ensemble_name)
  );

create policy ensemble_profiles_owner_update on public.ensemble_profiles
  for update to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_approved_ensemble_claim(app_key, ensemble_name)
  )
  with check (
    owner_user_id = auth.uid()
    and public.has_approved_ensemble_claim(app_key, ensemble_name)
  );

create policy ensemble_profiles_owner_delete on public.ensemble_profiles
  for delete to authenticated
  using (
    owner_user_id = auth.uid()
    and public.has_approved_ensemble_claim(app_key, ensemble_name)
  );
