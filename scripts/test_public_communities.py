"""Adversarial checks for 0020_public_communities.sql.

Boots a DISPOSABLE PostgreSQL, applies the committed RUN_ALL.sql bundle onto
a Supabase-shaped stub, then applies 0020 on top and attacks it — the same
method as scripts/test_db_security.py, whose boot plumbing this reuses
rather than duplicating.

The attack that matters: `org_update` lets any org.admin holder PATCH the
organizations row, so without 0020's guard a school band's director could
mark their own private workspace world-joinable. Two of the checks below
exist for that one hole.

    python3 scripts/test_public_communities.py

NEVER point this at a real project. It creates and destroys its own cluster.
"""
import subprocess, sys, uuid, random, pathlib, os
ROOT = pathlib.Path("/home/user/Cadence-Labs")
sys.path.insert(0, str(ROOT / "scripts"))
import test_db_security as T          # reuse STUB_SQL / boot plumbing
T.PORT = str(random.randint(29000, 40000))
T.WORK = pathlib.Path(f"/tmp/cad0020-{T.PORT}")

# Apply the bundle as committed at HEAD rather than the working copy, so an
# uncommitted edit elsewhere in the tree cannot make this suite lie.
head = subprocess.run(["git", "-C", str(ROOT), "show",
                       "HEAD:supabase/migrations/RUN_ALL.sql"],
                      capture_output=True, text=True, check=True).stdout
tmp = T.WORK.parent / f"RUN_ALL_head_{T.PORT}.sql"
T.sh(f"rm -rf {T.WORK}; mkdir -p {T.WORK}; chown postgres:postgres {T.WORK}")
tmp.write_text(head)
T.sh(f"su postgres -s /bin/bash -c \"{T.PGBIN}/initdb -D {T.WORK}/data -U postgres -A trust >/dev/null\"")
T.sh(f"su postgres -s /bin/bash -c \"{T.PGBIN}/pg_ctl -D {T.WORK}/data -o '-p {T.PORT} -k {T.WORK}' -l {T.WORK}/log start >/dev/null\"")
T.psql("select 1", db="postgres"); T.psql("create database cad", db="postgres")
for s in T.STUB_SQL: T.psql(s)
r = subprocess.run(["psql", "-h", str(T.WORK), "-p", T.PORT, "-U", "postgres", "-d", "cad",
                    "-v", "ON_ERROR_STOP=1", "-qf", str(tmp)], capture_output=True, text=True)
assert r.returncode == 0, r.stderr[-2000:]
print("HEAD RUN_ALL applied:", T.psql("select count(*) from pg_tables where schemaname='public'"), "tables")

r = subprocess.run(["psql", "-h", str(T.WORK), "-p", T.PORT, "-U", "postgres", "-d", "cad",
                    "-v", "ON_ERROR_STOP=1", "-qf",
                    str(ROOT / "supabase/migrations/0020_public_communities.sql")],
                   capture_output=True, text=True)
if r.returncode != 0:
    print(r.stderr[-3000:]); raise SystemExit("0020 FAILED TO APPLY")
print("0020 applied cleanly")

P, F = [], []
def ok(c, m): (P if c else F).append(m)

owner, joiner, outsider = (str(uuid.uuid4()) for _ in range(3))
for u, e in ((owner, "own"), (joiner, "join"), (outsider, "out")):
    T.psql(f"insert into auth.users (id,email) values ('{u}','{e}@t.local')")
T.U = {}
good, out = T.run_as(owner, "insert into public.organizations (name,slug,created_by) "
                            f"values ('Fans','fans','{owner}')")
assert good, out
org = T.psql("select id from public.organizations where slug='fans'")

# a director must NOT be able to publish their own workspace
bad, msg = T.run_as(owner, f"update public.organizations set is_public=true where id='{org}'")
ok(not bad and "public_flags_readonly" in msg, "director cannot publish their own workspace")
bad, msg = T.run_as(owner, f"update public.organizations set public_join_role_key='owner' where id='{org}'")
ok(not bad and "public_flags_readonly" in msg, "director cannot change the public join role")

# before publishing: invisible and unjoinable
ok(T.psql("select count(*) from public.list_public_orgs()") == "0", "no communities before opt-in")
bad, msg = T.run_as(joiner, f"select public.join_public_org('{org}')")
ok(not bad and "not_a_public_community" in msg, "a private workspace refuses join_public_org")

# platform publishes it (service-role path)
T.psql(f"update public.organizations set is_public=true, public_blurb='hi' where id='{org}'")
ok(T.psql("select count(*) from public.list_public_orgs()") == "1", "published community is discoverable")
ok(T.psql("select blurb from public.list_public_orgs()") == "hi", "blurb is returned")

good, out = T.run_as(joiner, f"select public.join_public_org('{org}')")
ok(good, "anyone signed in can join a public community")
ok(T.psql(f"select r.key from public.org_members m join public.org_roles r on r.id=m.role_id "
          f"where m.org_id='{org}' and m.user_id='{joiner}'") == "guest",
   "joiner lands in the guest role")
ok(T.psql(f"select array_to_string(r.permissions,',') from public.org_members m "
          f"join public.org_roles r on r.id=m.role_id where m.user_id='{joiner}'") == "announce.view",
   "guest holds announce.view and nothing else")
good, _ = T.run_as(joiner, f"select public.join_public_org('{org}')")
ok(good and T.psql(f"select count(*) from public.org_members where org_id='{org}' and user_id='{joiner}'") == "1",
   "joining twice is idempotent")
ok(T.psql(f"select count(*) from public.org_audit_log where org_id='{org}' "
          f"and action='member.joined_public'") == "1", "the join is audited")

# leaving
good, _ = T.run_as(joiner, f"select public.leave_public_org('{org}')")
ok(good and T.psql(f"select count(*) from public.org_members where org_id='{org}' and user_id='{joiner}'") == "0",
   "a member can leave a public community")
bad, msg = T.run_as(owner, f"select public.leave_public_org('{org}')")
ok(not bad and "owner_cannot_leave" in msg, "the owner cannot abandon the community")

# anon may look but not join
bad, msg = T.run_as(None, f"select public.join_public_org('{org}')", role="anon")
ok(not bad, "anon cannot join")
good, _ = T.run_as(None, "select count(*) from public.list_public_orgs()", role="anon")
ok(good, "anon can see the community exists")

# a public org still hides its roster from non-members
bad, _ = T.run_as(outsider, f"select case when count(*)>0 then 1/0 else 1 end "
                            f"from public.org_members where org_id='{org}'")
ok(not bad, "a public community still hides its roster from non-members")

print(f"\nPASS {len(P)}")
for p in P: print("  ok  ", p)
if F:
    print(f"FAIL {len(F)}")
    for f in F: print("  FAIL", f)
T.sh(f"su postgres -s /bin/bash -c \"{T.PGBIN}/pg_ctl -D {T.WORK}/data stop -m immediate >/dev/null\"", check=False)
sys.exit(1 if F else 0)
