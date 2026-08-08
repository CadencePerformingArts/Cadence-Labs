-- ═══════════════════════════════════════════════════════════════════════
-- CADENCE ENSEMBLE — file storage & the music library (Phase 4)
--
-- Nested folders, per-folder access control, versioned files, tags, music
-- metadata (production / movement / instrument / section), favorites, a
-- private Storage bucket with RLS keyed on organization, and a running
-- storage-usage counter that feeds the quota bar in the UI.
--
-- ─── RIGHTS NOTICE ────────────────────────────────────────────────────
-- Cadence provides storage. ORGANIZATIONS ARE RESPONSIBLE FOR HOLDING THE
-- RIGHTS to any sheet music, arrangements, recordings, drill, photography
-- or other media they upload, and for the licences their members' use of
-- that material requires. Cadence does not review, clear, license or
-- redistribute uploaded material.
--
-- NOTHING UPLOADED IS EVER PUBLIC BY DEFAULT. The 'ensemble' bucket is
-- created private (public = false); every object is reachable only through
-- a short-lived signed URL minted for a signed-in member whose row-level
-- permissions allow reading the owning file. There is no code path in this
-- schema — and none in the client — that produces a public object URL.
-- ──────────────────────────────────────────────────────────────────────
--
-- ─── Owner: run this once in the Supabase SQL editor. ───
-- Depends on: 0001 (touch_updated_at), 0005 (organizations, org_members,
-- org_groups, org_roles, org_seasons and the is_org_member / org_has_perm /
-- org_can_write / org_member_id / is_group_member helpers).
--
-- If your SQL editor role does not own storage.objects, the final section
-- (bucket + storage policies) will error. See the notes there: create the
-- bucket in Dashboard → Storage (name 'ensemble', Public = OFF) and add the
-- four policies from Dashboard → Storage → Policies using the same
-- expressions; the helper functions themselves live in `public` and are
-- created successfully either way.
-- ═══════════════════════════════════════════════════════════════════════

-- ═══ tables ═══════════════════════════════════════════════════════════

-- ── folders (nestable: Season 2026 ▸ Music ▸ Brass ▸ Trumpet)
create table if not exists public.org_folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  parent_id uuid references public.org_folders(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  kind text not null default 'general'
    check (kind in ('general', 'music', 'audio', 'video', 'visual',
                    'admin', 'travel', 'staff', 'booster')),
  season_id uuid references public.org_seasons(id) on delete set null,
  created_by_member uuid references public.org_members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists org_folders_org_idx on public.org_folders (org_id);
create index if not exists org_folders_parent_idx on public.org_folders (parent_id);
-- one folder name per level (root treated as a fixed sentinel parent)
create unique index if not exists org_folders_unique_name
  on public.org_folders (org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

-- ── per-folder access. NO ROWS = every active member of the org may view.
--    A row grants view; can_upload additionally grants upload.
create table if not exists public.org_folder_access (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.org_folders(id) on delete cascade,
  group_id uuid references public.org_groups(id) on delete cascade,
  role_kind text
    check (role_kind in ('owner', 'staff', 'leadership', 'member', 'parent',
                         'booster', 'volunteer', 'alumni', 'guest')),
  can_upload boolean not null default false,
  created_at timestamptz not null default now(),
  -- a rule must name something
  constraint org_folder_access_target check (group_id is not null or role_kind is not null)
);
create index if not exists org_folder_access_folder_idx on public.org_folder_access (folder_id);
-- (partial indexes rather than a NULLS NOT DISTINCT unique — works on any PG)
create unique index if not exists org_folder_access_group_uniq
  on public.org_folder_access (folder_id, group_id) where group_id is not null;
create unique index if not exists org_folder_access_role_uniq
  on public.org_folder_access (folder_id, role_kind) where role_kind is not null;

-- ── files. storage_path is the object key inside the private 'ensemble'
--    bucket and is laid out as  <org_id>/<folder_id|root>/<uuid>_<name>
--    so the Storage policies can authorize an object without a join.
create table if not exists public.org_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  folder_id uuid references public.org_folders(id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 200),
  storage_path text not null unique,
  mime text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  tags text[] not null default '{}',
  version int not null default 1 check (version >= 1),
  replaces_file_id uuid references public.org_files(id) on delete set null,
  uploaded_by_member uuid references public.org_members(id) on delete set null,
  -- ── music-library metadata (all optional; a PDF part fills them all in)
  instrument text,        -- 'Trumpet 2'
  section text,           -- 'Brass'
  production text,        -- '2026 — "Meridian"'
  movement text,          -- 'Mvt. II — Drift'
  season_id uuid references public.org_seasons(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists org_files_org_idx on public.org_files (org_id, created_at desc);
create index if not exists org_files_folder_idx on public.org_files (folder_id);
create index if not exists org_files_tags_idx on public.org_files using gin (tags);
create index if not exists org_files_music_idx
  on public.org_files (org_id, production, movement, section, instrument);
create index if not exists org_files_replaces_idx on public.org_files (replaces_file_id);

drop trigger if exists org_files_touch on public.org_files;
create trigger org_files_touch before update on public.org_files
  for each row execute function public.touch_updated_at();

-- ── favorites ("my part", starred practice tracks)
create table if not exists public.org_file_favorites (
  file_id uuid not null references public.org_files(id) on delete cascade,
  member_id uuid not null references public.org_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (file_id, member_id)
);
create index if not exists org_file_favorites_member_idx on public.org_file_favorites (member_id);

-- ═══ access helpers (SECURITY DEFINER: they read membership/group tables
--     that the caller may not select directly, and they must not recurse
--     back into the policies that call them) ══════════════════════════

-- Can the caller SEE this folder?
--   • must be an active member of the folder's org
--   • every folder on the path from this folder up to the root that carries
--     access rows must match the caller (by group membership or role kind).
--     A folder with no access rows is open to the whole org.
--   • 'file.manage' holders always see everything (they administer it)
create or replace function public.can_see_folder(p_folder uuid)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  f public.org_folders%rowtype;
  cur uuid := p_folder;
  hops int := 0;
  matched boolean;
begin
  if p_folder is null then return false; end if;
  select * into f from public.org_folders where id = p_folder;
  if not found then return false; end if;
  if not public.is_org_member(f.org_id) then return false; end if;
  if public.org_has_perm(f.org_id, 'file.manage') then return true; end if;

  while cur is not null and hops < 12 loop
    select * into f from public.org_folders where id = cur;
    exit when not found;
    if exists (select 1 from public.org_folder_access a where a.folder_id = f.id) then
      select exists (
        select 1 from public.org_folder_access a
         where a.folder_id = f.id
           and (
             (a.group_id is not null and public.is_group_member(a.group_id))
             or (a.role_kind is not null and exists (
                   select 1 from public.org_members m
                     join public.org_roles r on r.id = m.role_id
                    where m.org_id = f.org_id and m.user_id = auth.uid()
                      and m.status = 'active' and r.kind = a.role_kind))
           )
      ) into matched;
      if not matched then return false; end if;
    end if;
    cur := f.parent_id;
    hops := hops + 1;
  end loop;
  return true;
end $$;

-- Can the caller UPLOAD into this folder?
--   sight of the folder + 'file.upload' + a writable subscription, and when
--   the folder carries access rules, a matching rule with can_upload.
create or replace function public.can_upload_folder(p_folder uuid)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  f public.org_folders%rowtype;
  matched boolean;
begin
  if p_folder is null then return false; end if;
  select * into f from public.org_folders where id = p_folder;
  if not found then return false; end if;
  if not public.can_see_folder(p_folder) then return false; end if;
  if public.org_can_write(f.org_id, 'file.manage') then return true; end if;
  if not public.org_can_write(f.org_id, 'file.upload') then return false; end if;
  if not exists (select 1 from public.org_folder_access a where a.folder_id = f.id) then
    return true;
  end if;
  select exists (
    select 1 from public.org_folder_access a
     where a.folder_id = f.id and a.can_upload
       and (
         (a.group_id is not null and public.is_group_member(a.group_id))
         or (a.role_kind is not null and exists (
               select 1 from public.org_members m
                 join public.org_roles r on r.id = m.role_id
                where m.org_id = f.org_id and m.user_id = auth.uid()
                  and m.status = 'active' and r.kind = a.role_kind))
       )
  ) into matched;
  return matched;
end $$;

revoke execute on function public.can_see_folder(uuid) from public, anon;
revoke execute on function public.can_upload_folder(uuid) from public, anon;
grant execute on function public.can_see_folder(uuid) to authenticated;
grant execute on function public.can_upload_folder(uuid) to authenticated;

-- ═══ storage accounting ═══════════════════════════════════════════════

-- keeps organizations.storage_used_bytes truthful without the client ever
-- being trusted to report it
create or replace function public.bump_org_storage()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.organizations
       set storage_used_bytes = greatest(0, storage_used_bytes + coalesce(new.size_bytes, 0))
     where id = new.org_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.organizations
       set storage_used_bytes = greatest(0, storage_used_bytes - coalesce(old.size_bytes, 0))
     where id = old.org_id;
    return old;
  else
    if coalesce(new.size_bytes, 0) <> coalesce(old.size_bytes, 0) or new.org_id <> old.org_id then
      update public.organizations
         set storage_used_bytes = greatest(0, storage_used_bytes - coalesce(old.size_bytes, 0))
       where id = old.org_id;
      update public.organizations
         set storage_used_bytes = greatest(0, storage_used_bytes + coalesce(new.size_bytes, 0))
       where id = new.org_id;
    end if;
    return new;
  end if;
end $$;

drop trigger if exists org_files_storage_usage on public.org_files;
create trigger org_files_storage_usage
  after insert or update of size_bytes, org_id or delete on public.org_files
  for each row execute function public.bump_org_storage();

-- the quota is enforced here, not in the browser: a workspace at its limit
-- cannot record new files no matter what the client sends. Downloads and
-- reads are never affected.
create or replace function public.enforce_org_storage_quota()
returns trigger language plpgsql security definer set search_path = public as $$
declare o public.organizations%rowtype;
begin
  select * into o from public.organizations where id = new.org_id;
  if not found then raise exception 'unknown_org'; end if;
  if o.storage_used_bytes + coalesce(new.size_bytes, 0) > o.storage_quota_bytes then
    raise exception 'storage_quota_exceeded'
      using hint = 'This workspace is out of storage. Remove files or upgrade the plan.';
  end if;
  return new;
end $$;

drop trigger if exists org_files_quota on public.org_files;
create trigger org_files_quota before insert on public.org_files
  for each row execute function public.enforce_org_storage_quota();

-- A folder's access rules are what protect the files inside it. Deleting a
-- folder would set its files' folder_id to null, which makes them readable
-- by the whole workspace — so a folder must be emptied first, on purpose.
create or replace function public.guard_folder_delete()
returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from public.org_folders c where c.parent_id = old.id) then
    raise exception 'folder_not_empty'
      using hint = 'Move or delete the sub-folders inside it first.';
  end if;
  if exists (select 1 from public.org_files f where f.folder_id = old.id) then
    raise exception 'folder_not_empty'
      using hint = 'Move or delete the files inside it first.';
  end if;
  return old;
end $$;

drop trigger if exists org_folders_guard_delete on public.org_folders;
create trigger org_folders_guard_delete before delete on public.org_folders
  for each row execute function public.guard_folder_delete();

-- owner utility: recompute a workspace's usage from the file rows
create or replace function public.recount_org_storage(p_org uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare total bigint;
begin
  select coalesce(sum(size_bytes), 0) into total from public.org_files where org_id = p_org;
  update public.organizations set storage_used_bytes = total where id = p_org;
  return total;
end $$;
revoke execute on function public.recount_org_storage(uuid) from public, anon, authenticated;

-- ═══ RLS ══════════════════════════════════════════════════════════════
alter table public.org_folders enable row level security;
alter table public.org_folder_access enable row level security;
alter table public.org_files enable row level security;
alter table public.org_file_favorites enable row level security;

-- folders: see what you're allowed to see; make sub-folders where you may
-- upload; renaming/moving/deleting is a 'file.manage' job.
drop policy if exists folders_read on public.org_folders;
create policy folders_read on public.org_folders for select to authenticated
  using (public.can_see_folder(id));
drop policy if exists folders_insert on public.org_folders;
create policy folders_insert on public.org_folders for insert to authenticated
  with check (
    public.org_can_write(org_id, 'file.upload')
    and (parent_id is null or public.can_upload_folder(parent_id))
  );
drop policy if exists folders_update on public.org_folders;
create policy folders_update on public.org_folders for update to authenticated
  using (public.org_can_write(org_id, 'file.manage'))
  with check (public.org_can_write(org_id, 'file.manage'));
drop policy if exists folders_delete on public.org_folders;
create policy folders_delete on public.org_folders for delete to authenticated
  using (public.org_can_write(org_id, 'file.manage'));

-- folder access rules: visible to anyone who can see the folder, editable
-- only by 'file.manage'
drop policy if exists folder_access_read on public.org_folder_access;
create policy folder_access_read on public.org_folder_access for select to authenticated
  using (public.can_see_folder(folder_id));
drop policy if exists folder_access_write on public.org_folder_access;
create policy folder_access_write on public.org_folder_access for all to authenticated
  using (exists (select 1 from public.org_folders f
                  where f.id = folder_id and public.org_can_write(f.org_id, 'file.manage')))
  with check (exists (select 1 from public.org_folders f
                  where f.id = folder_id and public.org_can_write(f.org_id, 'file.manage')));

-- files: readable when the folder is visible (root-level files are visible
-- to the whole org); uploadable with 'file.upload' into a folder you may
-- upload to, attributed to your own member row; rename/delete = 'file.manage'
drop policy if exists files_read on public.org_files;
create policy files_read on public.org_files for select to authenticated
  using (
    public.is_org_member(org_id)
    and (folder_id is null or public.can_see_folder(folder_id))
  );
drop policy if exists files_insert on public.org_files;
create policy files_insert on public.org_files for insert to authenticated
  with check (
    public.org_can_write(org_id, 'file.upload')
    and (folder_id is null or public.can_upload_folder(folder_id))
    and uploaded_by_member = public.org_member_id(org_id)
  );
drop policy if exists files_update on public.org_files;
create policy files_update on public.org_files for update to authenticated
  using (public.org_can_write(org_id, 'file.manage'))
  with check (public.org_can_write(org_id, 'file.manage'));
drop policy if exists files_delete on public.org_files;
create policy files_delete on public.org_files for delete to authenticated
  using (public.org_can_write(org_id, 'file.manage'));

-- favorites: strictly your own, and only on files you can already read
-- (org_files' own RLS applies inside this subquery)
drop policy if exists favs_own on public.org_file_favorites;
create policy favs_own on public.org_file_favorites for all to authenticated
  using (exists (select 1 from public.org_files f
                  where f.id = file_id and member_id = public.org_member_id(f.org_id)))
  with check (exists (select 1 from public.org_files f
                  where f.id = file_id and member_id = public.org_member_id(f.org_id)));

-- ═══════════════════════════════════════════════════════════════════════
-- STORAGE: the private 'ensemble' bucket
--
-- Object keys are  <org_id>/<folder_id|'root'>/<uuid>_<filename>
-- so every authorization decision is derivable from the key itself:
--   (storage.foldername(name))[1]::uuid = the owning organization
--   (storage.foldername(name))[2]::uuid = the owning folder ('root' = none)
--
-- public = false. Nothing here ever mints a public URL; the client asks for
-- a short-lived signed URL per download/preview.
-- ═══════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit)
values ('ensemble', 'ensemble', false, 524288000)   -- 500 MB per object
on conflict (id) do nothing;

-- path parsers. They do exactly (storage.foldername(name))[n]::uuid, but
-- return null instead of raising when a key is malformed or the segment is
-- the literal 'root' — a policy that raises would 500 instead of denying.
create or replace function public.ensemble_path_org(p_name text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return (storage.foldername(p_name))[1]::uuid;
exception when others then return null;
end $$;

create or replace function public.ensemble_path_folder(p_name text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return (storage.foldername(p_name))[2]::uuid;
exception when others then return null;
end $$;

-- READ: you must be a member of the org named by the key, and you must be
-- able to read the org_files row that owns the object. Objects with no file
-- row yet (an upload mid-flight, or an orphan) are visible only to people
-- who could have uploaded them.
create or replace function public.can_read_ensemble_object(p_name text)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  org uuid := public.ensemble_path_org(p_name);
  f public.org_files%rowtype;
begin
  if org is null then return false; end if;
  if not public.is_org_member(org) then return false; end if;
  select * into f from public.org_files where storage_path = p_name;
  if found then
    if f.org_id <> org then return false; end if;
    return f.folder_id is null or public.can_see_folder(f.folder_id);
  end if;
  -- no row: uploaders and managers only
  return public.org_has_perm(org, 'file.manage') or public.org_can_write(org, 'file.upload');
end $$;

-- WRITE: member of the org in the key, holds 'file.upload' on a writable
-- workspace, and — when the key names a folder — may upload into it.
create or replace function public.can_write_ensemble_object(p_name text)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  org uuid := public.ensemble_path_org(p_name);
  fol uuid := public.ensemble_path_folder(p_name);
begin
  if org is null then return false; end if;
  if not public.is_org_member(org) then return false; end if;
  if not public.org_can_write(org, 'file.upload') then return false; end if;
  if fol is null then return true; end if;   -- root of the workspace
  return exists (select 1 from public.org_folders f where f.id = fol and f.org_id = org)
         and public.can_upload_folder(fol);
end $$;

-- DELETE: 'file.manage', or the uploader clearing up an orphan object that
-- never got a file row (a failed upload).
create or replace function public.can_delete_ensemble_object(p_name text)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  org uuid := public.ensemble_path_org(p_name);
begin
  if org is null then return false; end if;
  if public.org_can_write(org, 'file.manage') then return true; end if;
  return not exists (select 1 from public.org_files where storage_path = p_name)
         and public.org_can_write(org, 'file.upload');
end $$;

revoke execute on function public.ensemble_path_org(text) from public, anon;
revoke execute on function public.ensemble_path_folder(text) from public, anon;
revoke execute on function public.can_read_ensemble_object(text) from public, anon;
revoke execute on function public.can_write_ensemble_object(text) from public, anon;
revoke execute on function public.can_delete_ensemble_object(text) from public, anon;
grant execute on function public.ensemble_path_org(text) to authenticated;
grant execute on function public.ensemble_path_folder(text) to authenticated;
grant execute on function public.can_read_ensemble_object(text) to authenticated;
grant execute on function public.can_write_ensemble_object(text) to authenticated;
grant execute on function public.can_delete_ensemble_object(text) to authenticated;

-- ── policies on storage.objects ───────────────────────────────────────
-- If this block errors with "must be owner of table objects", run the four
-- CREATE POLICY statements from Dashboard → Storage → Policies instead
-- (New policy → For full customization), pasting the same expressions.
alter table storage.objects enable row level security;

drop policy if exists ensemble_objects_read on storage.objects;
create policy ensemble_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'ensemble' and public.can_read_ensemble_object(name));

drop policy if exists ensemble_objects_insert on storage.objects;
create policy ensemble_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'ensemble' and public.can_write_ensemble_object(name));

drop policy if exists ensemble_objects_update on storage.objects;
create policy ensemble_objects_update on storage.objects for update to authenticated
  using (bucket_id = 'ensemble' and public.can_write_ensemble_object(name))
  with check (bucket_id = 'ensemble' and public.can_write_ensemble_object(name));

drop policy if exists ensemble_objects_delete on storage.objects;
create policy ensemble_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'ensemble' and public.can_delete_ensemble_object(name));

-- ═══ Owner workflow queries ═══════════════════════════════════════════
-- Confirm the bucket is private (this must print f):
--   select id, public from storage.buckets where id = 'ensemble';
--
-- Largest files in a workspace:
--   select name, size_bytes, created_at from org_files
--    where org_id = '<uuid>' order by size_bytes desc limit 25;
--
-- Re-sync a workspace's usage counter after manual cleanup:
--   select public.recount_org_storage('<org uuid>');
--
-- Find storage objects with no file row (failed uploads) older than a day:
--   select o.name, o.created_at from storage.objects o
--    left join public.org_files f on f.storage_path = o.name
--    where o.bucket_id = 'ensemble' and f.id is null
--      and o.created_at < now() - interval '1 day';
--
-- Raise a paid workspace's quota (25 GB):
--   update organizations set storage_quota_bytes = 26843545600 where slug = '…';
