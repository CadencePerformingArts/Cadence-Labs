-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — unattended subscription sweep (+ the past_due gap it closes)
--
-- Two problems with 0015's sweep:
--
--   1. It is gated on `padmin_require()`, which needs `auth.uid()`. A timer
--      (pg_cron, a worker, anything without a signed-in user) therefore
--      cannot run it — so trial and grace expiry only ever happened when a
--      human opened admin-platform.html and pressed the button.
--
--   2. It only expired `grace_period`. But the Stripe webhook records a
--      failed payment as `status = 'past_due'` with a `grace_ends_at` 14
--      days out (see supabase/functions/_shared/stripe-core.js,
--      `invoice.payment_failed`), and `org_writable()` counts `past_due`
--      as writable. Nothing ever moved those organizations on. A workspace
--      whose card failed stayed fully writable forever.
--
-- This file adds `sweep_subscriptions_auto()` — the same state machine with
-- no signed-in-user requirement, executable only by the owner (postgres)
-- and the service role, never by `anon` or `authenticated` — makes the
-- admin RPC a thin authorised wrapper around it, and schedules it hourly
-- with pg_cron where the extension is available.
--
-- Nothing is ever deleted: `read_only` keeps every announcement, file,
-- message and attendance record readable. Only new writing stops.
--
-- Depends on: 0005 (organizations), 0015 (padmin_log, padmin_require).
-- ═══════════════════════════════════════════════════════════════════════

-- ── the unattended sweep ───────────────────────────────────────────────
-- SECURITY DEFINER with no caller check on purpose: the privilege boundary
-- is the EXECUTE grant below, not a claim inspected at runtime. Browsers
-- (anon / authenticated) cannot reach it at all; the admin RPC and the
-- scheduler can.
create or replace function public.sweep_subscriptions_auto()
returns jsonb language plpgsql security definer set search_path = public as $$
declare expired int; graced int; overdue int;
begin
  update public.organizations set status = 'read_only'
   where status = 'trialing' and trial_ends_at is not null and trial_ends_at < now();
  get diagnostics expired = row_count;

  update public.organizations set status = 'read_only'
   where status = 'grace_period' and grace_ends_at is not null and grace_ends_at < now();
  get diagnostics graced = row_count;

  -- the gap: a failed card leaves the org `past_due` with a grace deadline
  update public.organizations set status = 'read_only'
   where status = 'past_due' and grace_ends_at is not null and grace_ends_at < now();
  get diagnostics overdue = row_count;

  perform public.padmin_log('subscriptions.swept', null, null,
    jsonb_build_object('trials_expired', expired, 'grace_expired', graced,
                       'past_due_expired', overdue));

  return jsonb_build_object('trials_expired', expired, 'grace_expired', graced,
                            'past_due_expired', overdue);
end $$;

revoke all on function public.sweep_subscriptions_auto() from public, anon, authenticated;
-- the service role is server-side only (worker / edge function), so it may
-- drive the sweep on a timer without a signed-in platform admin
grant execute on function public.sweep_subscriptions_auto() to service_role;

-- ── the admin button now delegates ─────────────────────────────────────
-- One implementation, two doors. `padmin_require()` still guards the door
-- a browser can knock on; inside the definer body the effective user is the
-- owner, so the revoked helper is reachable from here and nowhere else.
create or replace function public.padmin_sweep_subscriptions()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.padmin_require();
  return public.sweep_subscriptions_auto();
end $$;
revoke execute on function public.padmin_sweep_subscriptions() from public, anon;
grant execute on function public.padmin_sweep_subscriptions() to authenticated;

-- ── schedule it, where the platform allows ─────────────────────────────
-- Guarded exactly like 0017's storage block: this file also rides inside
-- the single-transaction RUN_ALL / RUN_ENSEMBLE bundles, and pg_cron is a
-- hosted-platform privilege that a scratch database or a restricted SQL
-- role will not have. Where it fails, the admin page button still works and
-- this prints a notice instead of taking the whole schema down with it.
--
-- :17 past the hour rather than :00 so it never lands in the same minute as
-- the platform's own maintenance jobs.
do $$
begin
  execute 'create extension if not exists pg_cron';
  perform cron.schedule('cadence-subscription-sweep', '17 * * * *',
                        'select public.sweep_subscriptions_auto()');
  raise notice 'Cadence: hourly subscription sweep scheduled (pg_cron).';
exception
  when others then
    raise notice 'Cadence: could not schedule the sweep with pg_cron (%). Trial and grace expiry then depend on the admin-platform.html button, or on any scheduler that can call sweep_subscriptions_auto() with the service role.', sqlerrm;
end $$;
