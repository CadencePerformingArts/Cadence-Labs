-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — post-migration security hardening
--
-- From the Supabase advisor pass after 0009. Three findings, all real:
--   * 17 SECURITY DEFINER functions were executable by `anon`
--   * six of those are trigger-only and should be callable by nobody
--   * the workspace directory view was readable by signed-out visitors
--
-- Applied to the live project as migration `harden_function_grants`.
-- ═══════════════════════════════════════════════════════════════════════

-- 1. Trigger functions are trigger-only: nothing should reach them through
--    the REST API. Postgres fires triggers regardless of EXECUTE grants.
revoke execute on function public.bump_org_storage() from public, anon, authenticated;
revoke execute on function public.enforce_org_storage_quota() from public, anon, authenticated;
revoke execute on function public.seed_new_organization() from public, anon, authenticated;
revoke execute on function public.stamp_audit_actor() from public, anon, authenticated;
revoke execute on function public.stamp_form_submission() from public, anon, authenticated;
revoke execute on function public.sync_member_auto_groups() from public, anon, authenticated;

-- 2. Policy helpers are internals of RLS, not public RPCs. They must stay
--    executable by `authenticated` — a policy is evaluated with the caller's
--    privileges, so revoking that would make every policy raise — but signed
--    out visitors have no business calling them.
revoke execute on function public.can_manage_event(uuid) from public, anon;
revoke execute on function public.can_manage_packing_list(uuid) from public, anon;
revoke execute on function public.can_see_event(uuid) from public, anon;
revoke execute on function public.can_see_packing_list(uuid) from public, anon;
revoke execute on function public.can_see_signup(uuid) from public, anon;
revoke execute on function public.event_org(uuid) from public, anon;
revoke execute on function public.is_task_assignee(uuid) from public, anon;
revoke execute on function public.org_acts_for_member(uuid) from public, anon;
revoke execute on function public.poll_results_visible(uuid) from public, anon;
revoke execute on function public.signup_org(uuid) from public, anon;
revoke execute on function public.slot_signup(uuid) from public, anon;

grant execute on function public.can_manage_event(uuid) to authenticated;
grant execute on function public.can_manage_packing_list(uuid) to authenticated;
grant execute on function public.can_see_event(uuid) to authenticated;
grant execute on function public.can_see_packing_list(uuid) to authenticated;
grant execute on function public.can_see_signup(uuid) to authenticated;
grant execute on function public.event_org(uuid) to authenticated;
grant execute on function public.is_task_assignee(uuid) to authenticated;
grant execute on function public.org_acts_for_member(uuid) to authenticated;
grant execute on function public.poll_results_visible(uuid) to authenticated;
grant execute on function public.signup_org(uuid) to authenticated;
grant execute on function public.slot_signup(uuid) to authenticated;

-- 3. The workspace directory exists so someone can find an organization and
--    request access — which only makes sense signed in, and keeps the list of
--    organizations off the open internet.
revoke select on public.org_directory from anon;
grant select on public.org_directory to authenticated;

comment on view public.org_directory is
  'Safe, signed-in-only discovery surface for organizations: name, slug, type and whether they accept access requests. Deliberately a definer view so it can expose those columns without granting any access to public.organizations itself.';

comment on table public.plus_pending is
  'Service-role only by design: RLS is on with no policies, so no client can read or write it. Holds Cadence+ entitlements paid for before the buyer created an account.';
