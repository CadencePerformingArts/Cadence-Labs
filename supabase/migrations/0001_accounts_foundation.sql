-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — accounts foundation
--
-- Profiles, cross-device favorites and preference sync, Cadence+
-- entitlements (service-role-written, Stripe-ready), and the Ensemble Pro /
-- Event Pro claim pipeline. Everything is RLS-guarded.
--
-- Run this FIRST — every later migration builds on profiles,
-- touch_updated_at() and claims.
-- ═══════════════════════════════════════════════════════════════════════

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  app_ns text not null,           -- '' = DCI, 'wgi-perc:' etc — matches client storage namespaces
  name text not null,             -- exact ensemble name as that app renders it
  created_at timestamptz not null default now(),
  primary key (user_id, app_ns, name)
);

create table public.preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,              -- namespaced client key, e.g. 'boa:cad-notify-classes'
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table public.plus_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'none' check (status in ('none','beta','active','canceled')),
  source text,                    -- 'beta-code' | 'stripe' | …
  since timestamptz,
  updated_at timestamptz not null default now()
);

create table public.claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('ensemble','event')),
  app_key text not null,          -- 'dci', 'wgi/guard', 'boa', …
  target_name text not null,
  claimant_role text not null,
  message text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewer_note text
);
create index claims_user_idx on public.claims (user_id);
create index claims_status_idx on public.claims (status);

-- shared touch trigger used by every later migration
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger preferences_touch before update on public.preferences
  for each row execute function public.touch_updated_at();
create trigger entitlements_touch before update on public.plus_entitlements
  for each row execute function public.touch_updated_at();

-- every new auth user gets a profile + entitlement row automatically
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.plus_entitlements (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.favorites enable row level security;
alter table public.preferences enable row level security;
alter table public.plus_entitlements enable row level security;
alter table public.claims enable row level security;

create policy "own profile read" on public.profiles
  for select using ((select auth.uid()) = id);
create policy "own profile update" on public.profiles
  for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "own favorites read" on public.favorites
  for select using ((select auth.uid()) = user_id);
create policy "own favorites insert" on public.favorites
  for insert with check ((select auth.uid()) = user_id);
create policy "own favorites delete" on public.favorites
  for delete using ((select auth.uid()) = user_id);

create policy "own prefs read" on public.preferences
  for select using ((select auth.uid()) = user_id);
create policy "own prefs insert" on public.preferences
  for insert with check ((select auth.uid()) = user_id);
create policy "own prefs update" on public.preferences
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own prefs delete" on public.preferences
  for delete using ((select auth.uid()) = user_id);

-- entitlements: clients may read their own; only the service role writes
create policy "own entitlement read" on public.plus_entitlements
  for select using ((select auth.uid()) = user_id);

create policy "own claims read" on public.claims
  for select using ((select auth.uid()) = user_id);
create policy "own claims insert" on public.claims
  for insert with check ((select auth.uid()) = user_id);
