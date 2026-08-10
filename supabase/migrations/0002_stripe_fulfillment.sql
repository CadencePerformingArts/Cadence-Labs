-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — Stripe fulfillment plumbing
--
-- Entitlements learn about Stripe, payments that arrive before an account
-- exists park in plus_pending, and the webhook edge function can resolve
-- users by email without exposing auth.users.
--
-- Depends on 0001.
-- ═══════════════════════════════════════════════════════════════════════

alter table public.plus_entitlements
  add column if not exists stripe_customer_id text,
  add column if not exists plan text;
create index if not exists plus_entitlements_customer_idx
  on public.plus_entitlements (stripe_customer_id);

create table public.plus_pending (
  email text primary key,          -- stored lowercased
  stripe_customer_id text,
  plan text,
  status text not null default 'active',
  since timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.plus_pending enable row level security;
-- no policies: service role only

create trigger plus_pending_touch before update on public.plus_pending
  for each row execute function public.touch_updated_at();

-- service-role-only email → user id lookup, used by the Stripe webhook
create or replace function public.get_user_id_by_email(p_email text)
returns uuid language sql security definer set search_path = public, auth as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1
$$;
revoke execute on function public.get_user_id_by_email(text) from public, anon, authenticated;

-- when a new user signs up, absorb any entitlement parked for their email
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare pend public.plus_pending%rowtype;
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.plus_entitlements (user_id) values (new.id) on conflict do nothing;
  select * into pend from public.plus_pending where email = lower(new.email);
  if found then
    update public.plus_entitlements
       set status = pend.status, source = 'stripe', plan = pend.plan,
           stripe_customer_id = pend.stripe_customer_id, since = pend.since
     where user_id = new.id;
    delete from public.plus_pending where email = pend.email;
  end if;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
