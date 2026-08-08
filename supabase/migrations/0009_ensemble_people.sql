-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — people, forms & organization billing (Phases 5, 7, 8)
--
-- Three things a real band program cannot run without:
--
--   1. PEOPLE — parents/guardians linked to the students they belong to, so
--      a guardian sees their own child's information and nothing else.
--   2. FORMS — medical, travel, sizing, volunteer, audition and survey
--      forms. Medical data is the most sensitive thing this product will
--      ever hold: a form marked `is_sensitive` is readable only by staff
--      who hold BOTH 'form.manage' AND 'student.info', plus the submitter
--      and that submitter's guardians. Never widen this.
--   3. ORGANIZATION BILLING — the org pays once, members join free. Schools
--      rarely pay by card, so there is a purchase-order path: a billing
--      contact record and an invoice the owner issues and marks paid.
--
-- Billing tables deliberately use org_has_perm(), NOT org_can_write():
-- a read_only / expired workspace must still be able to reach billing —
-- that is how it gets reactivated. Trial expiry NEVER deletes data.
--
-- ─── Owner: run this once in the Supabase SQL editor. ───
-- Depends on: 0004 (touch_updated_at) and 0005 (organizations, org_members,
-- org_roles, org_groups,
-- org_group_members, helper functions is_org_member / org_has_perm /
-- org_can_write / org_writable / org_member_id).
-- Idempotent where it must be: org_guardians may also be created by the
-- calendar migration, so it is created with `if not exists` and identical
-- columns, and its policies are dropped-then-created.
-- ═══════════════════════════════════════════════════════════════════════

-- ═══ 1. GUARDIANS ═══════════════════════════════════════════════════════
-- Many-to-many in both directions: a student may have several guardians,
-- and a guardian may have several students in the program. Both rows are
-- org_members in the SAME org — a guardian is a member with the 'parent'
-- role, not a separate account type.
create table if not exists public.org_guardians (
  guardian_member_id uuid not null references public.org_members(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  primary key (guardian_member_id, member_id)
);
-- optional descriptive columns (added separately so a concurrently-created
-- table with the base columns still ends up complete)
alter table public.org_guardians add column if not exists relationship text;
alter table public.org_guardians add column if not exists is_primary boolean not null default false;
alter table public.org_guardians add column if not exists created_at timestamptz not null default now();

create index if not exists org_guardians_member_idx on public.org_guardians (member_id);
create index if not exists org_guardians_org_idx on public.org_guardians (org_id);

-- am I a guardian of this member?
create or replace function public.is_guardian_of(p_member uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_guardians g
      join public.org_members gm on gm.id = g.guardian_member_id
     where g.member_id = p_member
       and gm.user_id = auth.uid() and gm.status = 'active'
  )
$$;

-- the member ids of the students I am a guardian of, in one org
create or replace function public.my_student_member_ids(p_org uuid)
returns setof uuid language sql security definer stable set search_path = public as $$
  select g.member_id from public.org_guardians g
    join public.org_members gm on gm.id = g.guardian_member_id
   where g.org_id = p_org and gm.user_id = auth.uid() and gm.status = 'active'
$$;

revoke execute on function public.is_guardian_of(uuid) from public, anon;
revoke execute on function public.my_student_member_ids(uuid) from public, anon;

alter table public.org_guardians enable row level security;

-- Guardian links are roster metadata: any member of the org may see that a
-- link exists (the directory shows "Guardian: …"), but only member.manage /
-- parent.info staff may create or break one. Contact DETAILS stay behind
-- org_member_contacts' stricter policy from 0005 — this table leaks nothing
-- beyond the fact of the relationship.
drop policy if exists guardians_read on public.org_guardians;
create policy guardians_read on public.org_guardians for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists guardians_write on public.org_guardians;
create policy guardians_write on public.org_guardians for all to authenticated
  using (public.org_can_write(org_id, 'member.manage'))
  with check (public.org_can_write(org_id, 'member.manage'));

-- ═══ 2. FORMS ═══════════════════════════════════════════════════════════
create table public.org_forms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  description text,
  kind text not null default 'general'
    check (kind in ('general', 'medical', 'travel', 'sizing', 'volunteer',
                    'audition', 'survey')),
  -- empty array = everyone in the org; otherwise only these groups (and the
  -- guardians of members in these groups) see the form
  target_group_ids uuid[] not null default '{}',
  -- medical / anything with protected information: reads narrow to
  -- 'student.info' holders. Medical forms default to sensitive in the UI.
  is_sensitive boolean not null default false,
  is_open boolean not null default true,
  closes_at timestamptz,
  season_id uuid references public.org_seasons(id) on delete set null,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index org_forms_org_idx on public.org_forms (org_id, created_at desc);

create table public.org_form_fields (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.org_forms(id) on delete cascade,
  label text not null,
  help text,
  field_type text not null default 'text'
    check (field_type in ('text', 'longtext', 'number', 'date', 'select',
                          'multiselect', 'checkbox', 'file', 'signature')),
  options text[] not null default '{}',
  required boolean not null default false,
  sort int not null default 100
);
create index org_form_fields_form_idx on public.org_form_fields (form_id, sort);

create table public.org_form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.org_forms(id) on delete cascade,
  -- org_id is denormalized so RLS can be evaluated without reading org_forms
  -- under the caller's own policies. It is FORCED by a trigger below, so a
  -- client cannot point a submission at an org it doesn't belong to.
  org_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid references public.org_members(id) on delete set null,
  submitted_by_user uuid references auth.users(id) on delete set null,
  data jsonb not null default '{}',
  files jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (form_id, member_id)
);
create index org_form_subs_form_idx on public.org_form_submissions (form_id, created_at desc);
create index org_form_subs_member_idx on public.org_form_submissions (member_id);

-- ── SECURITY DEFINER helpers. Policies must not read org_forms directly:
--    that would evaluate org_forms' own policies and can hide rows the
--    policy needs to see. These run as the table owner instead.
create or replace function public.org_form_org(p_form uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select f.org_id from public.org_forms f where f.id = p_form
$$;

create or replace function public.org_form_sensitive(p_form uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select f.is_sensitive from public.org_forms f where f.id = p_form), true)
$$;

-- may the caller SEE this form at all? (targeting + guardians + managers)
create or replace function public.org_form_visible(p_form uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.org_forms f
     where f.id = p_form
       and public.is_org_member(f.org_id)
       and (
         public.org_has_perm(f.org_id, 'form.manage')
         or cardinality(f.target_group_ids) = 0
         or exists (
           select 1 from public.org_group_members gm
             join public.org_members m on m.id = gm.member_id
            where m.user_id = auth.uid() and m.org_id = f.org_id and m.status = 'active'
              and gm.group_id = any (f.target_group_ids))
         or exists (   -- a guardian sees the forms aimed at their student
           select 1 from public.org_group_members gm
            where gm.member_id in (select public.my_student_member_ids(f.org_id))
              and gm.group_id = any (f.target_group_ids))
       )
  )
$$;

-- may the caller READ this submission? (submitter, their guardians, staff)
create or replace function public.org_submission_readable(p_form uuid, p_member uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select
    p_user = auth.uid()
    or (p_member is not null and p_member = public.org_member_id(public.org_form_org(p_form)))
    or (p_member is not null and public.is_guardian_of(p_member))
    or (
      public.org_has_perm(public.org_form_org(p_form), 'form.manage')
      and (
        not public.org_form_sensitive(p_form)
        -- SENSITIVE (medical, protected): student.info is also required
        or public.org_has_perm(public.org_form_org(p_form), 'student.info')
      )
    )
$$;

revoke execute on function public.org_form_org(uuid) from public, anon;
revoke execute on function public.org_form_sensitive(uuid) from public, anon;
revoke execute on function public.org_form_visible(uuid) from public, anon;
revoke execute on function public.org_submission_readable(uuid, uuid, uuid) from public, anon;

-- force org_id + submitted_by_user server-side; never trust the client
create or replace function public.stamp_form_submission()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.org_id := public.org_form_org(new.form_id);
  if new.org_id is null then raise exception 'form_not_found'; end if;
  if tg_op = 'INSERT' then
    new.submitted_by_user := coalesce(auth.uid(), new.submitted_by_user);
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger org_form_submissions_stamp
  before insert or update on public.org_form_submissions
  for each row execute function public.stamp_form_submission();

create trigger org_forms_touch before update on public.org_forms
  for each row execute function public.touch_updated_at();

alter table public.org_forms enable row level security;
alter table public.org_form_fields enable row level security;
alter table public.org_form_submissions enable row level security;

create policy forms_read on public.org_forms for select to authenticated
  using (public.org_form_visible(id));
create policy forms_write on public.org_forms for all to authenticated
  using (public.org_can_write(org_id, 'form.manage'))
  with check (public.org_can_write(org_id, 'form.manage'));

create policy form_fields_read on public.org_form_fields for select to authenticated
  using (public.org_form_visible(form_id));
create policy form_fields_write on public.org_form_fields for all to authenticated
  using (public.org_can_write(public.org_form_org(form_id), 'form.manage'))
  with check (public.org_can_write(public.org_form_org(form_id), 'form.manage'));

-- Submissions: the heart of the medical-privacy rule.
create policy form_subs_read on public.org_form_submissions for select to authenticated
  using (public.org_submission_readable(form_id, member_id, submitted_by_user));

-- Submit for yourself, or for a student you are the guardian of; managers
-- may record a submission on someone's behalf (paper form typed in).
create policy form_subs_insert on public.org_form_submissions for insert to authenticated
  with check (
    public.org_writable(public.org_form_org(form_id))
    and public.org_form_visible(form_id)
    and (
      member_id = public.org_member_id(public.org_form_org(form_id))
      or (member_id is not null and public.is_guardian_of(member_id))
      or public.org_has_perm(public.org_form_org(form_id), 'form.manage')
    )
  );

create policy form_subs_update on public.org_form_submissions for update to authenticated
  using (
    public.org_writable(org_id)
    and (
      member_id = public.org_member_id(org_id)
      or (member_id is not null and public.is_guardian_of(member_id))
      or public.org_can_write(org_id, 'form.manage')
    )
  )
  with check (
    member_id = public.org_member_id(org_id)
    or (member_id is not null and public.is_guardian_of(member_id))
    or public.org_can_write(org_id, 'form.manage')
  );

create policy form_subs_delete on public.org_form_submissions for delete to authenticated
  using (public.org_can_write(org_id, 'form.manage'));

-- ═══ 3. ORGANIZATION BILLING ════════════════════════════════════════════
-- One subscription covers the whole organization. Members never pay.
-- No card is charged anywhere in this schema — these rows record what the
-- school agreed to and what the owner issued. Stripe fields on
-- organizations (stripe_customer_id) stay authoritative for card billing.

create table public.org_billing_contacts (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  legal_name text,             -- 'Westfield High School Band Boosters, Inc.'
  contact_name text,
  contact_email text,
  contact_phone text,
  address text,
  po_number text,              -- the district's purchase order number
  tax_exempt_id text,
  notes text,
  updated_at timestamptz not null default now()
);

create table public.org_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  number text,                 -- 'CAD-2026-0007' — assigned when issued
  amount_cents bigint not null default 0,
  currency text not null default 'usd',
  status text not null default 'requested'
    check (status in ('requested', 'sent', 'paid', 'void')),
  plan text check (plan in ('trial', 'ensemble', 'pro', 'program', 'none')),
  period_start date,
  period_end date,
  due_on date,
  issued_at timestamptz,
  paid_at timestamptz,
  note text,
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, number)
);
create index org_invoices_org_idx on public.org_invoices (org_id, created_at desc);

create trigger org_billing_contacts_touch before update on public.org_billing_contacts
  for each row execute function public.touch_updated_at();

alter table public.org_billing_contacts enable row level security;
alter table public.org_invoices enable row level security;

-- NOTE: org_has_perm, not org_can_write — a read_only or expired workspace
-- must still reach billing, otherwise it can never be reactivated.
create policy billing_contacts_rw on public.org_billing_contacts for all to authenticated
  using (public.org_has_perm(org_id, 'billing.manage'))
  with check (public.org_has_perm(org_id, 'billing.manage'));

create policy invoices_read on public.org_invoices for select to authenticated
  using (public.org_has_perm(org_id, 'billing.manage'));

-- A workspace may REQUEST an invoice. Issuing, numbering and marking paid
-- are owner-side actions (service role / SQL editor) — nothing in the
-- browser may declare an invoice paid.
create policy invoices_request on public.org_invoices for insert to authenticated
  with check (
    public.org_has_perm(org_id, 'billing.manage')
    and status = 'requested'
    and paid_at is null and issued_at is null and number is null
  );

create policy invoices_cancel_request on public.org_invoices for update to authenticated
  using (public.org_has_perm(org_id, 'billing.manage') and status = 'requested')
  with check (public.org_has_perm(org_id, 'billing.manage') and status in ('requested', 'void'));

-- ═══ Owner workflow queries ═════════════════════════════════════════════
--
-- ── Approve an access request and add the member ────────────────────────
--   with req as (
--     update public.org_access_requests
--        set status = 'approved', reviewed_at = now(), reviewer_note = 'welcome'
--      where id = '<request-id>'
--    returning org_id, user_id)
--   insert into public.org_members (org_id, user_id, role_id, status, season_id)
--   select req.org_id, req.user_id,
--          (select id from public.org_roles r where r.org_id = req.org_id and r.key = 'member'),
--          'active',
--          (select id from public.org_seasons s where s.org_id = req.org_id and s.is_current
--            order by created_at desc limit 1)
--     from req
--   on conflict (org_id, user_id) do nothing;
--   -- (the UI in admin.html performs exactly this, in two requests)
--
-- ── Link a guardian to a student ────────────────────────────────────────
--   insert into public.org_guardians (org_id, guardian_member_id, member_id, relationship)
--   values ('<org>', '<parent member id>', '<student member id>', 'Mother')
--   on conflict do nothing;
--
-- ── Activate a plan after payment clears ────────────────────────────────
--   update public.organizations
--      set plan = 'ensemble', status = 'active',
--          renews_at = now() + interval '1 year',
--          storage_quota_bytes = 10737418240,   -- 10 GB (see core.js PLANS)
--          grace_ends_at = null
--    where slug = '<org-slug>';
--   -- pro: 26843545600 (25 GB) · program: 107374182400 (100 GB)
--
-- ── Issue an invoice against a request, then mark it paid ───────────────
--   update public.org_invoices
--      set status = 'sent', number = 'CAD-2026-0007', issued_at = now(),
--          amount_cents = 14900, due_on = current_date + 30
--    where id = '<invoice-id>';
--
--   update public.org_invoices set status = 'paid', paid_at = now()
--    where id = '<invoice-id>';
--   -- then flip the org to invoice_pending → active:
--   update public.organizations set status = 'active', renews_at = now() + interval '1 year'
--    where id = (select org_id from public.org_invoices where id = '<invoice-id>');
--
-- ── Nightly trial / grace sweep (cron; NEVER deletes anything) ──────────
--   update public.organizations
--      set status = 'read_only'
--    where (status = 'trialing'     and trial_ends_at < now())
--       or (status = 'grace_period' and grace_ends_at < now());
--   -- past_due → grace_period after a week of no payment:
--   update public.organizations
--      set status = 'grace_period', grace_ends_at = now() + interval '14 days'
--    where status = 'past_due' and updated_at < now() - interval '7 days';
--   -- an invoice that went unpaid past its due date:
--   update public.organizations o
--      set status = 'grace_period', grace_ends_at = now() + interval '14 days'
--     from public.org_invoices i
--    where i.org_id = o.id and i.status = 'sent' and i.due_on < current_date
--      and o.status = 'invoice_pending';
--
-- ── Close a form and export its submissions (managers only) ─────────────
--   update public.org_forms set is_open = false where id = '<form-id>';
--   select m.display_name, s.data
--     from public.org_form_submissions s
--     join public.org_members m on m.id = s.member_id
--    where s.form_id = '<form-id>' order by m.display_name;
-- ═══════════════════════════════════════════════════════════════════════
