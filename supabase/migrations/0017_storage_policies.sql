-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE — the `ensemble` bucket's four object policies, standalone
--
-- 0008 creates these inside an exception-guarded DO block, because on some
-- projects the SQL editor's role cannot alter storage.objects and an abort
-- there would have rolled back all 56 tables. On this project that block
-- WAS skipped, which left the private bucket with zero policies — RLS on,
-- nothing allowed, so every upload and download was denied.
--
-- This file applies them on their own, so the state is reproducible instead
-- of depending on which role happened to run 0008. It is safe to re-run and
-- safe to run before or after 0008 (the helper functions it calls are
-- created there; run 0008 first on a fresh project).
--
-- If this file fails with "must be owner of table objects", your SQL role
-- lacks the privilege — apply it through the Supabase MCP/management API,
-- or create the same four policies in Dashboard → Storage → Policies.
--
-- Depends on: 0008 (bucket + can_*_ensemble_object helpers).
-- ═══════════════════════════════════════════════════════════════════════

-- Exception-guarded like 0008's block, because this file also rides inside
-- the single-transaction RUN_ALL / RUN_ENSEMBLE bundles: an unguarded
-- failure here would roll the whole bundle back. Guarded, it applies where
-- the role is privileged (MCP / management API) and prints a notice where
-- it is not — never taking the rest of the schema down with it.
do $$
begin
  execute 'alter table storage.objects enable row level security';

  execute 'drop policy if exists ensemble_objects_read on storage.objects';
  execute $p$create policy ensemble_objects_read on storage.objects for select to authenticated
    using (bucket_id = 'ensemble' and public.can_read_ensemble_object(name))$p$;

  execute 'drop policy if exists ensemble_objects_insert on storage.objects';
  execute $p$create policy ensemble_objects_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))$p$;

  execute 'drop policy if exists ensemble_objects_update on storage.objects';
  execute $p$create policy ensemble_objects_update on storage.objects for update to authenticated
    using (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))
    with check (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))$p$;

  execute 'drop policy if exists ensemble_objects_delete on storage.objects';
  execute $p$create policy ensemble_objects_delete on storage.objects for delete to authenticated
    using (bucket_id = 'ensemble' and public.can_delete_ensemble_object(name))$p$;

  raise notice 'Cadence: ensemble storage policies applied.';
exception
  when insufficient_privilege or undefined_table then
    raise notice 'Cadence: this role cannot alter storage.objects (%). Apply 0017 through the Supabase MCP/management API, or create the four policies in Dashboard -> Storage -> Policies. Until then file upload/download stays denied.', sqlerrm;
end $$;
