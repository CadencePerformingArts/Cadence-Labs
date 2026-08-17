-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — platform administration
--
-- Until now, running the platform meant hand-editing rows in the SQL
-- editor (approving claims, activating plans, marking invoices paid —
-- the runbooks in 0004/0005/0009's comments). This gives the owner a real
-- surface: narrow SECURITY DEFINER RPCs, every one gated on
-- profiles.role = 'platform_admin' (0004 defines the role and already
-- blocks self-assignment), every action audited. docs/admin-platform.html
-- is the UI; the SQL runbooks remain as emergency fallbacks.
--
-- The service-role key is NOT used by any of this — the owner signs in
-- like any user, and the platform_admin row (set once, by the owner, in
-- the dashboard) is the authority. Enable MFA on that account before
-- production use; the RPCs are written so an MFA (aal2) requirement can
-- be added as one line when Supabase MFA is turned on.
--
-- Depends on: 0001 (claims), 0004 (profiles.role), 0005 (organizations),
-- 0009 (org_invoices), 0014 (org_notifications).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                  where id = auth.uid() and role = 'platform_admin')
$$;
revoke execute on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- immutable platform-level audit (separate from per-org logs on purpose:
-- org admins must not see platform operations)
create table public.platform_audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
alter table public.platform_audit_log enable row level security;
create policy padmin_audit_read on public.platform_audit_log
  for select to authenticated using (public.is_platform_admin());
-- no insert/update/delete policies: only the definer functions write

create or replace function public.padmin_log(p_action text, p_type text, p_id text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.platform_audit_log (actor_user_id, action, target_type, target_id, detail)
  values (auth.uid(), p_action, p_type, p_id, coalesce(p_detail, '{}'::jsonb));
end $$;
revoke execute on function public.padmin_log(text, text, text, jsonb) from public, anon, authenticated;

-- every RPC starts here
create or replace function public.padmin_require()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'platform_admin_required';
  end if;
end $$;
revoke execute on function public.padmin_require() from public, anon, authenticated;

-- ── claims review ──────────────────────────────────────────────────────
create or replace function public.padmin_list_claims(p_status text default 'pending')
returns table (id uuid, user_id uuid, kind text, app_key text, target_name text,
               claimant_role text, message text, status text, created_at timestamptz,
               claimant_email text)
language sql stable security definer set search_path = public as $$
  select c.id, c.user_id, c.kind, c.app_key, c.target_name, c.claimant_role,
         c.message, c.status, c.created_at, u.email
    from public.claims c left join auth.users u on u.id = c.user_id
   where public.is_platform_admin()
     and (p_status is null or c.status = p_status)
   order by c.created_at
$$;
revoke execute on function public.padmin_list_claims(text) from public, anon;
grant execute on function public.padmin_list_claims(text) to authenticated;

create or replace function public.padmin_review_claim(p_claim uuid, p_action text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c public.claims%rowtype;
begin
  perform public.padmin_require();
  if p_action not in ('approved', 'rejected', 'pending') then
    raise exception 'bad_action: approved / rejected / pending';
  end if;
  select * into c from public.claims where id = p_claim for update;
  if not found then raise exception 'no_such_claim'; end if;
  update public.claims
     set status = p_action, reviewed_at = now(), reviewer_note = p_note
   where id = p_claim;
  perform public.padmin_log('claim.' || p_action, 'claim', p_claim::text,
    jsonb_build_object('app_key', c.app_key, 'target', c.target_name));
end $$;
revoke execute on function public.padmin_review_claim(uuid, text, text) from public, anon;
grant execute on function public.padmin_review_claim(uuid, text, text) to authenticated;

-- ── organizations & plans ──────────────────────────────────────────────
create or replace function public.padmin_list_orgs()
returns table (id uuid, name text, slug text, plan text, status text,
               trial_ends_at timestamptz, renews_at timestamptz,
               storage_used_bytes bigint, storage_quota_bytes bigint,
               members bigint, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.slug, o.plan, o.status, o.trial_ends_at, o.renews_at,
         o.storage_used_bytes, o.storage_quota_bytes,
         (select count(*) from public.org_members m
           where m.org_id = o.id and m.status = 'active'),
         o.created_at
    from public.organizations o
   where public.is_platform_admin()
   order by o.created_at desc
$$;
revoke execute on function public.padmin_list_orgs() from public, anon;
grant execute on function public.padmin_list_orgs() to authenticated;

-- activate / change a plan (the invoice-paid path; Stripe's webhook uses
-- the service role instead and never calls this)
create or replace function public.padmin_set_plan(
  p_org uuid, p_plan text, p_renews_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare quota bigint;
begin
  perform public.padmin_require();
  if p_plan not in ('ensemble', 'pro', 'program') then
    raise exception 'bad_plan: ensemble / pro / program';
  end if;
  quota := case p_plan when 'ensemble' then 10737418240      -- 10 GB
                       when 'pro' then 26843545600            -- 25 GB
                       else 107374182400 end;                 -- 100 GB
  update public.organizations
     set plan = p_plan, status = 'active',
         renews_at = coalesce(p_renews_at, now() + interval '1 year'),
         grace_ends_at = null,
         storage_quota_bytes = greatest(storage_quota_bytes, quota)
   where id = p_org;
  if not found then raise exception 'no_such_org'; end if;
  perform public.padmin_log('org.plan_set', 'org', p_org::text,
    jsonb_build_object('plan', p_plan));
end $$;
revoke execute on function public.padmin_set_plan(uuid, text, timestamptz) from public, anon;
grant execute on function public.padmin_set_plan(uuid, text, timestamptz) to authenticated;

create or replace function public.padmin_extend_trial(p_org uuid, p_days int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.padmin_require();
  if p_days is null or p_days < 1 or p_days > 180 then
    raise exception 'bad_days: 1-180';
  end if;
  update public.organizations
     set status = 'trialing',
         trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => p_days)
   where id = p_org;
  if not found then raise exception 'no_such_org'; end if;
  perform public.padmin_log('org.trial_extended', 'org', p_org::text,
    jsonb_build_object('days', p_days));
end $$;
revoke execute on function public.padmin_extend_trial(uuid, int) from public, anon;
grant execute on function public.padmin_extend_trial(uuid, int) to authenticated;

-- ── invoices ───────────────────────────────────────────────────────────
create or replace function public.padmin_list_invoices(p_status text default null)
returns table (id uuid, org_id uuid, org_name text, number text, amount_cents bigint,
               status text, plan text, due_on date, issued_at timestamptz,
               paid_at timestamptz, note text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.id, i.org_id, o.name, i.number, i.amount_cents, i.status, i.plan,
         i.due_on, i.issued_at, i.paid_at, i.note, i.created_at
    from public.org_invoices i join public.organizations o on o.id = i.org_id
   where public.is_platform_admin()
     and (p_status is null or i.status = p_status)
   order by i.created_at desc
$$;
revoke execute on function public.padmin_list_invoices(text) from public, anon;
grant execute on function public.padmin_list_invoices(text) to authenticated;

create or replace function public.padmin_issue_invoice(
  p_invoice uuid, p_number text, p_amount_cents bigint, p_due date)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.padmin_require();
  update public.org_invoices
     set number = p_number, amount_cents = p_amount_cents,
         due_on = p_due, status = 'sent', issued_at = now()
   where id = p_invoice and status in ('requested', 'sent');
  if not found then raise exception 'no_such_invoice_or_not_issuable'; end if;
  perform public.padmin_log('invoice.issued', 'invoice', p_invoice::text,
    jsonb_build_object('number', p_number, 'amount_cents', p_amount_cents));
end $$;
revoke execute on function public.padmin_issue_invoice(uuid, text, bigint, date) from public, anon;
grant execute on function public.padmin_issue_invoice(uuid, text, bigint, date) to authenticated;

-- marking paid activates the plan in the same transaction — the two never
-- drift apart the way the manual runbook could
create or replace function public.padmin_mark_invoice_paid(p_invoice uuid)
returns void language plpgsql security definer set search_path = public as $$
declare inv public.org_invoices%rowtype;
begin
  perform public.padmin_require();
  select * into inv from public.org_invoices where id = p_invoice for update;
  if not found then raise exception 'no_such_invoice'; end if;
  if inv.status = 'paid' then return; end if;    -- idempotent
  if inv.status not in ('sent', 'requested') then
    raise exception 'invoice_not_payable';
  end if;
  update public.org_invoices set status = 'paid', paid_at = now() where id = p_invoice;
  if inv.plan in ('ensemble', 'pro', 'program') then
    perform public.padmin_set_plan(inv.org_id, inv.plan,
      coalesce(inv.period_end::timestamptz, now() + interval '1 year'));
  end if;
  perform public.padmin_log('invoice.paid', 'invoice', p_invoice::text,
    jsonb_build_object('org', inv.org_id, 'plan', inv.plan));
end $$;
revoke execute on function public.padmin_mark_invoice_paid(uuid) from public, anon;
grant execute on function public.padmin_mark_invoice_paid(uuid) to authenticated;

-- ── operational health, one call ───────────────────────────────────────
create or replace function public.padmin_health()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when public.is_platform_admin() then jsonb_build_object(
    'pending_claims', (select count(*) from public.claims where status = 'pending'),
    'orgs', (select count(*) from public.organizations),
    'trials_expiring_14d', (select count(*) from public.organizations
       where status = 'trialing' and trial_ends_at < now() + interval '14 days'),
    'read_only_orgs', (select count(*) from public.organizations
       where status in ('read_only', 'expired')),
    'invoices_awaiting', (select count(*) from public.org_invoices
       where status in ('requested', 'sent')),
    'notifications_failed', (select count(*) from public.org_notifications
       where status = 'failed'),
    'notifications_pending', (select count(*) from public.org_notifications
       where status = 'pending')
  ) else null end
$$;
revoke execute on function public.padmin_health() from public, anon;
grant execute on function public.padmin_health() to authenticated;

-- ── the trial/grace sweep the runbook used to do by hand ───────────────
-- Idempotent; run from the worker on a timer or by the admin page button.
create or replace function public.padmin_sweep_subscriptions()
returns jsonb language plpgsql security definer set search_path = public as $$
declare expired int; graced int;
begin
  perform public.padmin_require();
  update public.organizations set status = 'read_only'
   where status = 'trialing' and trial_ends_at is not null and trial_ends_at < now();
  get diagnostics expired = row_count;
  update public.organizations set status = 'read_only'
   where status = 'grace_period' and grace_ends_at is not null and grace_ends_at < now();
  get diagnostics graced = row_count;
  perform public.padmin_log('subscriptions.swept', null, null,
    jsonb_build_object('trials_expired', expired, 'grace_expired', graced));
  return jsonb_build_object('trials_expired', expired, 'grace_expired', graced);
end $$;
revoke execute on function public.padmin_sweep_subscriptions() from public, anon;
grant execute on function public.padmin_sweep_subscriptions() to authenticated;
