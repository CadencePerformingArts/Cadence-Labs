-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — Stripe webhook idempotency ledger
--
-- Every Stripe event the webhook processes is recorded here FIRST; the
-- primary key makes a second delivery of the same event a no-op (Stripe
-- retries on any non-2xx, and deliveries can arrive out of order — the
-- handlers set absolute state, so replay-safety only needs this dedupe).
--
-- Service-role only: RLS is enabled with no policies, so no client can
-- read or write it. The webhook edge function bypasses RLS by design.
--
-- Depends on: nothing new (organizations.stripe_customer_id is 0005).
-- ═══════════════════════════════════════════════════════════════════════

create table public.stripe_events (
  id text primary key,                -- Stripe event id ('evt_…')
  type text not null,
  received_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
-- no policies on purpose: the service role bypasses RLS, everyone else
-- (anon, authenticated) has no path in

-- keep the ledger from growing forever: the platform admin sweep may prune
-- entries older than 90 days (Stripe never retries that far back)
create or replace function public.prune_stripe_events()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.padmin_require();
  delete from public.stripe_events where received_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.prune_stripe_events() from public, anon;
grant execute on function public.prune_stripe_events() to authenticated;
