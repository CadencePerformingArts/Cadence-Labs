#!/usr/bin/env python3
"""Adversarial security suite for the Cadence database.

Boots a DISPOSABLE PostgreSQL, applies supabase/migrations/RUN_ALL.sql onto a
Supabase-shaped stub (auth/storage schemas, anon/authenticated/service_role
roles), seeds the personas below, then replays real attacks as real roles —
`SET ROLE authenticated` + a JWT claim, exactly how PostgREST executes — and
asserts that every forbidden operation fails AND every legitimate one still
works. It exists so the vulnerabilities fixed in 0012 can never quietly
return.

    python3 scripts/test_db_security.py            # full run (boots pg)
    python3 scripts/test_db_security.py --keep     # leave the instance up

NEVER point this at a real project: it creates and destroys data by design.
It only ever talks to the private socket of the instance it just created.

Personas: A-owner, A-director, A-staff (member.manage), A-student (minor),
A-parent, A-member2, B-owner, B-member, anonymous, expired read-only org C.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PGBIN = Path("/usr/lib/postgresql/16/bin")
WORK = Path("/tmp/cadsec")
PORT = "5599"

STUB_SQL = [
    """create schema auth;
       create table auth.users (id uuid primary key default gen_random_uuid(),
         email text, raw_user_meta_data jsonb default '{}'::jsonb,
         created_at timestamptz default now());
       create or replace function auth.uid() returns uuid language sql stable as
         $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
       do $do$ begin
         create role anon nologin; exception when duplicate_object then null; end $do$;
       do $do$ begin
         create role authenticated nologin; exception when duplicate_object then null; end $do$;
       do $do$ begin
         create role service_role nologin; exception when duplicate_object then null; end $do$;
       grant usage on schema public to anon, authenticated, service_role;
       alter default privileges in schema public
         grant select, insert, update, delete on tables to authenticated;
       alter default privileges in schema public grant insert on tables to anon;
       create schema storage;
       create table storage.buckets (id text primary key, name text,
         public boolean default false, file_size_limit bigint,
         allowed_mime_types text[], created_at timestamptz default now());
       create table storage.objects (id uuid default gen_random_uuid(),
         bucket_id text, name text, owner uuid,
         metadata jsonb default '{}'::jsonb, created_at timestamptz default now());
       create schema extensions;""",
]

PASS: list[str] = []
FAIL: list[str] = []


def sh(cmd: str, check: bool = True) -> str:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"$ {cmd}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def psql(sql: str, db: str = "cad", check: bool = True) -> str:
    r = subprocess.run(
        [str(PGBIN.parent.parent / "bin" / "psql") if False else "psql",
         "-h", str(WORK), "-p", PORT, "-U", "postgres", "-d", db,
         "-v", "ON_ERROR_STOP=1", "-qtA", "-c", sql],
        capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"SQL failed:\n{sql}\n{r.stderr}")
    return r.stdout.strip()


def run_as(user_id: str | None, sql: str, role: str = "authenticated") -> tuple[bool, str]:
    """Execute sql exactly the way PostgREST would for this user."""
    setup = f"set role {role};"
    if user_id:
        setup += f" set request.jwt.claim.sub = '{user_id}';"
    else:
        setup += " set request.jwt.claim.sub = '';"
    r = subprocess.run(
        ["psql", "-h", str(WORK), "-p", PORT, "-U", "postgres", "-d", "cad",
         "-v", "ON_ERROR_STOP=1", "-qtA", "-c", f"{setup} {sql}"],
        capture_output=True, text=True)
    return r.returncode == 0, (r.stdout + r.stderr).strip()


def must_fail(label: str, user_id: str | None, sql: str, role: str = "authenticated"):
    # a blocked write is either a raised error OR an RLS-filtered 0-row update
    ok, out = run_as(user_id, sql, role)
    blocked = (not ok) or out.strip().endswith("UPDATE 0") or out.strip().endswith("DELETE 0") \
        or out.strip() == "INSERT 0 0"
    if blocked:
        PASS.append(label)
    else:
        FAIL.append(f"{label}: attack SUCCEEDED (must fail) -> {out[:80]}")


def must_raise(label: str, user_id: str | None, sql: str, role: str = "authenticated"):
    # the DATABASE must actively reject this even though the row is visible
    ok, out = run_as(user_id, sql, role)
    if not ok:
        PASS.append(label)
    else:
        FAIL.append(f"{label}: expected a hard rejection, got success -> {out[:80]}")


def must_work(label: str, user_id: str | None, sql: str, role: str = "authenticated"):
    ok, out = run_as(user_id, sql, role)
    if ok:
        PASS.append(label)
    else:
        FAIL.append(f"{label}: legitimate operation FAILED: {out[:180]}")


def boot():
    # stop any instance a crashed previous run left behind
    sh(f"su postgres -s /bin/bash -c \"{PGBIN}/pg_ctl -D {WORK}/data stop -m immediate\"", check=False)
    sh(f"rm -rf {WORK}; mkdir -p {WORK}; chown postgres:postgres {WORK}")
    sh(f"su postgres -s /bin/bash -c \"{PGBIN}/initdb -D {WORK}/data -U postgres -A trust >/dev/null\"")
    sh(f"su postgres -s /bin/bash -c \"{PGBIN}/pg_ctl -D {WORK}/data -o '-p {PORT} -k {WORK}' -l {WORK}/log start >/dev/null\"")
    psql("select 1", db="postgres")
    psql("create database cad", db="postgres")
    # Supabase-shaped stub: auth schema/uid(), roles, storage tables
    for stmt in STUB_SQL:
        psql(stmt)
    _OLD = """
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(),
        email text, raw_user_meta_data jsonb default '{}'::jsonb,
        created_at timestamptz default now());
      create or replace function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create role anon nologin; create role authenticated nologin;
      create role service_role nologin;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public
        grant select, insert, update, delete on tables to authenticated;
      alter default privileges in schema public grant insert on tables to anon;
      create schema storage;
      create table storage.buckets (id text primary key, name text,
        public boolean default false, file_size_limit bigint,
        allowed_mime_types text[], created_at timestamptz default now());
      create table storage.objects (id uuid default gen_random_uuid(),
        bucket_id text, name text, owner uuid,
        metadata jsonb default '{}'::jsonb, created_at timestamptz default now());
      create schema extensions;
    """
    print("applying RUN_ALL.sql …")
    r = subprocess.run(
        ["psql", "-h", str(WORK), "-p", PORT, "-U", "postgres", "-d", "cad",
         "-v", "ON_ERROR_STOP=1", "-qf", str(ROOT / "supabase/migrations/RUN_ALL.sql")],
        capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2000:])
        raise SystemExit("RUN_ALL.sql failed to apply")
    n = psql("select count(*) from pg_tables where schemaname='public'")
    print(f"  {n} tables")


def verify_additive_upgrade():
    """Prove 0012 applies cleanly ONTO an existing 0001-0011 database, not
    only into a fresh build — the real production scenario. Uses a second
    disposable database on the same instance."""
    print("verifying additive upgrade (0001-0011 then 0012) …")
    psql("create database cad_prior", db="postgres")
    # mirror the Supabase stub into the prior DB
    for stmt in STUB_SQL:
        psql(stmt, db="cad_prior")
    import glob, os
    prior = sorted(f for f in glob.glob(str(ROOT / "supabase/migrations/0[0-9][0-9][0-9]_*.sql"))
                   if os.path.basename(f) < "0012")
    for f in prior:
        r = subprocess.run(["psql", "-h", str(WORK), "-p", PORT, "-U", "postgres",
                            "-d", "cad_prior", "-v", "ON_ERROR_STOP=1", "-qf", f],
                           capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(f"prior migration {os.path.basename(f)} failed: {r.stderr[-800:]}")
    # now the corrective migration, exactly as an owner would paste it
    r = subprocess.run(["psql", "-h", str(WORK), "-p", PORT, "-U", "postgres",
                        "-d", "cad_prior", "-v", "ON_ERROR_STOP=1",
                        "-qf", str(ROOT / "supabase/migrations/0012_security_hardening.sql")],
                       capture_output=True, text=True)
    if r.returncode:
        FAIL.append(f"ADDITIVE: 0012 failed to apply onto 0001-0011: {r.stderr[-400:]}")
    else:
        PASS.append("ADDITIVE: 0012 applies cleanly onto an existing 0001-0011 database")
        # spot-check a couple of guards exist on the upgraded DB
        got = subprocess.run(["psql", "-h", str(WORK), "-p", PORT, "-U", "postgres",
                              "-d", "cad_prior", "-qtA", "-c",
                              "select count(*) from pg_trigger where tgname in "
                              "('org_members_guard','chats_stamp_safety','usage_events_stamp')"],
                             capture_output=True, text=True).stdout.strip()
        (PASS if got == "3" else FAIL).append(
            "ADDITIVE: new guards present after upgrade" if got == "3"
            else f"ADDITIVE: only {got}/3 new guards present after upgrade")


U = {k: str(uuid.uuid4()) for k in
     ["a_owner", "a_director", "a_staff", "a_student", "a_parent", "a_member2",
      "b_owner", "b_member", "c_owner"]}


def seed():
    for k, uid_ in U.items():
        psql(f"insert into auth.users (id, email) values ('{uid_}', '{k}@test.local')")
    # owners create orgs (seed trigger builds roles/groups/season/membership)
    for org, owner in [("Org A", "a_owner"), ("Org B", "b_owner"), ("Org C", "c_owner")]:
        slug = org.lower().replace(" ", "-")
        ok, out = run_as(U[owner], f"""
          insert into public.organizations (name, slug, created_by)
          values ('{org}', '{slug}', '{U[owner]}')""")
        assert ok, f"org creation failed for {org}: {out}"
    # look up ids we need (as superuser — test scaffolding, not the attack)
    global ORG_A, ORG_B, ORG_C
    ORG_A = psql("select id from public.organizations where slug='org-a'")
    ORG_B = psql("select id from public.organizations where slug='org-b'")
    ORG_C = psql("select id from public.organizations where slug='org-c'")

    def add_member(org, user_key, role_key, minor=False, section=None):
        return psql(f"""
          insert into public.org_members (org_id, user_id, role_id, status, season_id, is_minor)
          select '{org}', '{U[user_key]}', r.id, 'active', s.id, {str(minor).lower()}
            from public.org_roles r, public.org_seasons s
           where r.org_id = '{org}' and r.key = '{role_key}'
             and s.org_id = '{org}' and s.is_current
          returning id""")

    global MEM
    MEM = {
        "a_director": add_member(ORG_A, "a_director", "director"),
        "a_staff": add_member(ORG_A, "a_staff", "staff"),
        "a_student": add_member(ORG_A, "a_student", "member", minor=True),
        "a_parent": add_member(ORG_A, "a_parent", "parent"),
        "a_member2": add_member(ORG_A, "a_member2", "member"),
        "b_member": add_member(ORG_B, "b_member", "member"),
    }
    MEM["a_owner"] = psql(
        f"select id from public.org_members where org_id='{ORG_A}' and user_id='{U['a_owner']}'")
    MEM["b_owner"] = psql(
        f"select id from public.org_members where org_id='{ORG_B}' and user_id='{U['b_owner']}'")
    # org C: expired trial → read-only
    psql(f"update public.organizations set trial_ends_at = now() - interval '1 day', "
         f"status = 'read_only' where id = '{ORG_C}'")


def owner_role_id(org):
    return psql(f"select id from public.org_roles where org_id='{org}' and key='owner'")


def member_role_id(org):
    return psql(f"select id from public.org_roles where org_id='{org}' and key='member'")


def tests():
    student, staff, director = U["a_student"], U["a_staff"], U["a_director"]

    # ── 0A role escalation ────────────────────────────────────────────
    must_fail("0A: student self-promotes via PATCH role_id", student,
              f"update public.org_members set role_id='{owner_role_id(ORG_A)}' "
              f"where id='{MEM['a_student']}'")
    must_fail("0A: student flips own status", student,
              f"update public.org_members set status='active', season_id=null "
              f"where id='{MEM['a_student']}' and section is distinct from 'X'")
    must_raise("0A: director changes a role via raw PATCH is blocked (RPC required)", director,
              f"update public.org_members set role_id='{owner_role_id(ORG_A)}' "
              f"where id='{MEM['a_student']}'")
    must_fail("0A: director promotes THEMSELVES via RPC", director,
              f"select public.set_member_role('{MEM['a_director']}', '{owner_role_id(ORG_A)}')")
    must_work("0A: director changes another member's role via RPC", director,
              f"select public.set_member_role('{MEM['a_member2']}', "
              f"'{psql(f'select id from public.org_roles where org_id=%L and key=%L' % (chr(39)+ORG_A+chr(39), chr(39)+'leadership'+chr(39)))}')"
              if False else
              f"select public.set_member_role('{MEM['a_member2']}', "
              f"(select id from public.org_roles where org_id='{ORG_A}' and key='leadership'))")
    must_fail("0A: last-admin demotion blocked", U["b_owner"],
              f"select public.set_member_role('{MEM['b_owner']}', '{member_role_id(ORG_B)}')")
    must_work("0A: student edits harmless self fields", student,
              f"update public.org_members set custom = coalesce(custom,'{{}}'::jsonb) "
              f"where id='{MEM['a_student']}'")

    # ── 0B cross-org roles ────────────────────────────────────────────
    must_fail("0B: staff assigns an Org B role inside Org A", director,
              f"select public.set_member_role('{MEM['a_member2']}', '{owner_role_id(ORG_B)}')")
    must_fail("0B: invite with a foreign role_id", director,
              f"insert into public.org_invites (org_id, code, role_id, max_uses) "
              f"values ('{ORG_A}', 'EVIL{uuid.uuid4().hex[:6]}', '{owner_role_id(ORG_B)}', 5)")

    # ── 0C storage accounting ─────────────────────────────────────────
    must_raise("0C: director rewrites storage_used_bytes", director,
              f"update public.organizations set storage_used_bytes=999999 where id='{ORG_A}'")
    # legit: a file insert within quota works and bumps usage
    must_work("0C: staff uploads a file row", staff,
              f"insert into public.org_files (org_id, name, storage_path, size_bytes, uploaded_by_member) "
              f"values ('{ORG_A}', 'notes.pdf', '{ORG_A}/root/x1_notes.pdf', 1000, '{MEM['a_staff']}')")
    fid = psql(f"select id from public.org_files where org_id='{ORG_A}' limit 1")
    if not fid:
        FAIL.append("0C: file insert produced no row — dependent checks skipped")
        fid = None
    if fid: must_raise("0C: even a file manager cannot rewrite size_bytes", director,
              f"update public.org_files set size_bytes = 1 where id='{fid}'")
    if fid: must_work("0C: a file manager can still rename the file", director,
              f"update public.org_files set name = 'renamed.pdf' where id='{fid}'")
    # reconcile from the (stub) bucket: object says 5000
    if fid:
        psql(f"insert into storage.objects (bucket_id, name, metadata) values "
             f"('ensemble', '{ORG_A}/root/x1_notes.pdf', '{{\"size\": 5000}}'::jsonb)")
    must_work("0C: sync_file_size reconciles from storage", staff,
              f"select public.sync_file_size('{fid}')")
    got = psql(f"select size_bytes from public.org_files where id='{fid}'")
    (PASS if got == "5000" else FAIL).append(
        "0C: size reconciled to the object's real size" if got == "5000"
        else f"0C: size after sync = {got}, wanted 5000")
    used = psql(f"select storage_used_bytes from public.organizations where id='{ORG_A}'")
    (PASS if used == "5000" else FAIL).append(
        "0C: org usage matches reconciled size" if used == "5000"
        else f"0C: org usage = {used}, wanted 5000")

    # ── 0D invite atomicity ───────────────────────────────────────────
    code = "JOIN" + uuid.uuid4().hex[:8].upper()
    psql(f"insert into public.org_invites (org_id, code, max_uses, created_by) "
         f"values ('{ORG_A}', '{code}', 1, '{U['a_owner']}')")
    newbie = str(uuid.uuid4())
    psql(f"insert into auth.users (id, email) values ('{newbie}', 'newbie@test.local')")
    must_work("0D: fresh user redeems a valid invite", newbie,
              f"select public.redeem_org_invite('{code}')")
    must_work("0D: same user redeeming again is idempotent", newbie,
              f"select public.redeem_org_invite('{code}')")
    straggler = str(uuid.uuid4())
    psql(f"insert into auth.users (id, email) values ('{straggler}', 's@test.local')")
    must_fail("0D: exhausted invite refuses the next user", straggler,
              f"select public.redeem_org_invite('{code}')")
    # concurrency: two brand-new users race the last use of a fresh code
    code2 = "RACE" + uuid.uuid4().hex[:8].upper()
    psql(f"insert into public.org_invites (org_id, code, max_uses, created_by) "
         f"values ('{ORG_A}', '{code2}', 1, '{U['a_owner']}')")
    r1, r2 = str(uuid.uuid4()), str(uuid.uuid4())
    for u in (r1, r2):
        psql(f"insert into auth.users (id, email) values ('{u}', '{u[:8]}@r.local')")
    import threading
    results = {}
    def redeem(u):
        results[u] = run_as(u, f"select public.redeem_org_invite('{code2}')")[0]
    t1 = threading.Thread(target=redeem, args=(r1,)); t2 = threading.Thread(target=redeem, args=(r2,))
    t1.start(); t2.start(); t1.join(); t2.join()
    wins = sum(1 for ok in results.values() if ok)
    (PASS if wins == 1 else FAIL).append(
        "0D: concurrent last-use race admits exactly one" if wins == 1
        else f"0D: race admitted {wins} users on a 1-use invite")

    # ── 0E drill dots ─────────────────────────────────────────────────
    show = psql(f"insert into public.drill_shows (org_id, title) values ('{ORG_A}', 'Show') returning id")
    dot = psql(f"insert into public.drill_performers (show_id, label) values ('{show}', 'T1') returning id")
    must_work("0E: student claims an unclaimed dot", student,
              f"select public.claim_drill_dot('{dot}')")
    must_fail("0E: another member cannot steal the claimed dot", U["a_member2"],
              f"select public.claim_drill_dot('{dot}')")
    must_work("0E: reclaiming your own dot is fine", student,
              f"select public.claim_drill_dot('{dot}')")
    must_fail("0E: plain member cannot use assign_drill_dot", U["a_member2"],
              f"select public.assign_drill_dot('{dot}', '{MEM['a_member2']}')")
    must_work("0E: drill staff reassigns deliberately", director,
              f"select public.assign_drill_dot('{dot}', '{MEM['a_member2']}')")
    must_fail("0E: Org B member cannot touch Org A dots", U["b_member"],
              f"select public.claim_drill_dot('{dot}')")

    # ── 0F DM bypass ──────────────────────────────────────────────────
    # Org A keeps student DMs off (default). Student creates a "group" chat
    # and tries to add staff — the pair rule must apply regardless of kind.
    psql(f"update public.organizations set settings = settings || "
         f"'{{\"member_created_chats\": true}}'::jsonb where id = '{ORG_A}'")
    ok, chat_out = run_as(student,
        f"insert into public.chats (org_id, kind, title, created_by_member) "
        f"values ('{ORG_A}', 'group', 'totally a group', '{MEM['a_student']}') returning id")
    if not ok:
        PASS.append("0F: student chat creation refused outright (stricter than required)")
    else:
        chat = chat_out.splitlines()[0]
        run_as(student, f"insert into public.chat_members (chat_id, member_id) "
                        f"values ('{chat}', '{MEM['a_student']}')")
        must_fail("0F: student adds staff to 2-person 'group' (pair rule)", student,
                  f"insert into public.chat_members (chat_id, member_id) "
                  f"values ('{chat}', '{MEM['a_staff']}')")
        must_fail("0F: student adds another minor against student_dms=off", student,
                  f"insert into public.chat_members (chat_id, member_id) "
                  f"values ('{chat}', '{MEM['a_member2']}')" if False else
                  f"insert into public.chat_members (chat_id, member_id) "
                  f"values ('{chat}', (select id from public.org_members where org_id='{ORG_A}' and is_minor limit 1))")
    # staff-created rooms still work
    must_work("0F: staff creates a sanctioned group room", staff,
              f"insert into public.chats (org_id, kind, title, created_by_member) "
              f"values ('{ORG_A}', 'group', 'Brass', '{MEM['a_staff']}')")

    # ── 0G analytics identity ─────────────────────────────────────────
    sess = str(uuid.uuid4())
    run_as(student,
           f"insert into public.usage_events (session_id, user_id, app, screen, event) "
           f"values ('{sess}', '{U['a_owner']}', 'dci', 'scoreboard', 'view')")
    spoofed = psql(f"select count(*) from public.usage_events where user_id='{U['a_owner']}'")
    mine = psql(f"select count(*) from public.usage_events where user_id='{student}'")
    (PASS if spoofed == "0" and mine == "1" else FAIL).append(
        "0G: usage event carries the real identity, not the claimed one"
        if spoofed == "0" and mine == "1"
        else f"0G: spoofed rows={spoofed}, own rows={mine}")
    ok, _ = run_as(None, f"insert into public.usage_events (session_id, app, screen, event) "
                         f"values ('{uuid.uuid4()}', 'dci', 'scoreboard', 'view')", role="anon")
    (PASS if ok else FAIL).append("0G: anonymous events still record" if ok
                                  else "0G: anon analytics insert broke")

    # ── tenant isolation spot checks ──────────────────────────────────
    must_fail("ISO: Org B owner reads Org A roster", U["b_owner"],
              f"select 1 from public.org_members where org_id='{ORG_A}' limit 1"
              .replace("select 1", "select case when count(*)>0 then 1/0 else 1 end"))
    must_fail("ISO: Org B owner reads Org A files", U["b_owner"],
              f"select case when count(*)>0 then 1/0 else 1 end from public.org_files where org_id='{ORG_A}'")
    must_fail("ISO: anon reads any workspace", None,
              "select case when count(*)>0 then 1/0 else 1 end from public.organizations", role="anon")

    # ── notifications (0014) ──────────────────────────────────────────
    # an ack-required post enqueues in-app rows for the audience via trigger
    ok_post, post_out = run_as(director,
        f"insert into public.posts (org_id, author_member_id, title, body, requires_ack, priority) "
        f"values ('{ORG_A}', '{MEM['a_director']}', 'Read me', 'body', true, 'important') returning id",
        )
    if ok_post:
        pid = post_out.splitlines()[0]
        # the student should have an in-app notification queued
        got = psql(f"select count(*) from public.org_notifications where type='ack_post' "
                   f"and recipient_member_id='{MEM['a_student']}' and channel='inapp'")
        (PASS if got and int(got) >= 1 else FAIL).append(
            "NOTIF: ack-required post enqueues an in-app notification for the audience"
            if got and int(got) >= 1 else f"NOTIF: ack post enqueued {got} rows for student")
    else:
        FAIL.append("NOTIF: could not create ack post: " + post_out[:80])

    # a recipient reads only their own in-app notifications
    must_fail("NOTIF: member cannot read another member's notifications", U["a_member2"],
              "select case when count(*)>0 then 1/0 else 1 end from public.org_notifications "
              f"where recipient_member_id='{MEM['a_student']}'")
    # a recipient cannot forge a notification (no insert policy)
    must_fail("NOTIF: member cannot insert a notification", student,
              f"insert into public.org_notifications (org_id, recipient_member_id, type, channel, dedupe_key) "
              f"values ('{ORG_A}', '{MEM['a_student']}', 'ack_post', 'inapp', 'forged')")
    # a recipient may mark their own row read but not change its status
    nid = psql(f"select id from public.org_notifications where recipient_member_id='{MEM['a_student']}' "
               f"and channel='inapp' limit 1")
    if nid:
        must_work("NOTIF: recipient marks their own notification read", student,
                  f"update public.org_notifications set read_at=now() where id='{nid}'")
        must_raise("NOTIF: recipient cannot change status", student,
                  f"update public.org_notifications set status='sent' where id='{nid}'")
    # the worker surface is service-role only
    must_fail("NOTIF: authenticated cannot claim the queue", director,
              "select public.claim_notifications(10)")

    # an invite with an email enqueues an email notification
    icode = "INV" + uuid.uuid4().hex[:8].upper()
    run_as(director, f"insert into public.org_invites (org_id, code, email, max_uses, created_by) "
                     f"values ('{ORG_A}', '{icode}', 'newkid@example.com', 5, '{U['a_director']}')")
    got2 = psql("select count(*) from public.org_notifications where type='invite' "
                "and channel='email' and recipient_email='newkid@example.com'")
    (PASS if got2 and int(got2) == 1 else FAIL).append(
        "NOTIF: an invite with an email enqueues one email notification"
        if got2 and int(got2) == 1 else f"NOTIF: invite enqueued {got2} email rows")

    # ── platform admin (0015) ─────────────────────────────────────────
    # non-admins are refused everywhere, even org owners
    must_fail("PADMIN: org owner cannot list claims", U["a_owner"],
              "select * from public.padmin_list_claims('pending')" if False else
              "select case when count(*)>0 then 1/0 else 1 end from public.padmin_list_claims('pending')")
    must_raise("PADMIN: org owner cannot set a plan", U["a_owner"],
              f"select public.padmin_set_plan('{ORG_A}', 'program')")
    must_raise("PADMIN: org owner cannot mark invoices paid", U["a_owner"],
              f"select public.padmin_mark_invoice_paid('{uuid.uuid4()}')")
    # promote a persona to platform admin (superuser scaffolding, as the
    # dashboard owner would do it once)
    padmin_uid = str(uuid.uuid4())
    psql(f"insert into auth.users (id, email) values ('{padmin_uid}', 'owner@cadence.local')")
    psql(f"insert into public.profiles (id, role) values ('{padmin_uid}', 'platform_admin') "
         f"on conflict (id) do update set role='platform_admin'")
    # file a claim as a normal user, then review it as the admin
    run_as(U["a_member2"],
           f"insert into public.claims (user_id, kind, app_key, target_name, claimant_role) "
           f"values ('{U['a_member2']}', 'ensemble', 'dci', 'Test Corps', 'Director')")
    claim_id = psql("select id from public.claims where target_name='Test Corps'")
    must_work("PADMIN: admin lists pending claims", padmin_uid,
              "select count(*) from public.padmin_list_claims('pending')")
    must_work("PADMIN: admin approves a claim", padmin_uid,
              f"select public.padmin_review_claim('{claim_id}', 'approved', null)")
    got = psql(f"select status from public.claims where id='{claim_id}'")
    (PASS if got == "approved" else FAIL).append(
        "PADMIN: claim status updated" if got == "approved" else f"PADMIN: claim status={got}")
    # invoice flow: request -> issue -> paid activates the plan atomically
    inv_id = psql(f"insert into public.org_invoices (org_id, plan, requested_by) "
                  f"values ('{ORG_A}', 'ensemble', '{U['a_owner']}') returning id")
    must_work("PADMIN: admin issues the invoice", padmin_uid,
              f"select public.padmin_issue_invoice('{inv_id}', 'CAD-TEST-1', 14900, current_date + 30)")
    must_work("PADMIN: admin marks it paid", padmin_uid,
              f"select public.padmin_mark_invoice_paid('{inv_id}')")
    got = psql(f"select plan || '/' || status from public.organizations where id='{ORG_A}'")
    (PASS if got == "ensemble/active" else FAIL).append(
        "PADMIN: paid invoice activated the plan in the same transaction"
        if got == "ensemble/active" else f"PADMIN: org plan/status={got}")
    must_work("PADMIN: idempotent re-mark paid", padmin_uid,
              f"select public.padmin_mark_invoice_paid('{inv_id}')")
    # audit exists and only the admin can read it
    audits = psql("select count(*) from public.platform_audit_log")
    (PASS if int(audits) >= 3 else FAIL).append(
        "PADMIN: actions audited" if int(audits) >= 3 else f"PADMIN: only {audits} audit rows")
    must_fail("PADMIN: org owner cannot read the platform audit log", U["a_owner"],
              "select case when count(*)>0 then 1/0 else 1 end from public.platform_audit_log")
    must_work("PADMIN: health snapshot works for the admin", padmin_uid,
              "select public.padmin_health()")
    must_work("PADMIN: subscription sweep runs and audits", padmin_uid,
              "select public.padmin_sweep_subscriptions()")

    # ── unattended sweep (0018) ───────────────────────────────────────
    # the timer-callable helper must be unreachable from any browser role
    must_fail("SWEEP: authenticated cannot call sweep_subscriptions_auto", director,
              "select public.sweep_subscriptions_auto()")
    must_fail("SWEEP: anon cannot call sweep_subscriptions_auto", None,
              "select public.sweep_subscriptions_auto()", role="anon")
    # a failed card leaves an org past_due with a grace deadline; once that
    # deadline passes the workspace must stop being writable (0015 only ever
    # expired 'grace_period', so past_due orgs stayed writable forever)
    psql(f"update public.organizations set status='past_due', "
         f"grace_ends_at = now() - interval '1 day' where id='{ORG_C}'")
    got = psql("select public.sweep_subscriptions_auto()->>'past_due_expired'")
    (PASS if got == "1" else FAIL).append(
        "SWEEP: expired past_due org swept" if got == "1"
        else f"SWEEP: past_due_expired={got}, expected 1")
    got = psql(f"select status from public.organizations where id='{ORG_C}'")
    (PASS if got == "read_only" else FAIL).append(
        "SWEEP: past_due org past its grace date is now read_only" if got == "read_only"
        else f"SWEEP: org C status={got}")
    got = psql("select count(*) from public.platform_audit_log "
               "where action='subscriptions.swept' and actor_user_id is null")
    (PASS if int(got) >= 1 else FAIL).append(
        "SWEEP: an unattended sweep audits with no actor" if int(got) >= 1
        else "SWEEP: unattended sweep left no audit row")

    # ── read-only org enforcement ─────────────────────────────────────
    must_fail("RO: expired org rejects new posts", U["c_owner"],
              f"insert into public.posts (org_id, author_member_id, title, body) "
              f"values ('{ORG_C}', (select id from public.org_members where org_id='{ORG_C}' limit 1), 'x', 'y')")
    must_work("RO: expired org still reads its history", U["c_owner"],
              f"select count(*) from public.org_members where org_id='{ORG_C}'")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    try:
        boot()
        verify_additive_upgrade()
        seed()
        tests()
    finally:
        if not args.keep:
            sh(f"su postgres -s /bin/bash -c \"{PGBIN}/pg_ctl -D {WORK}/data stop -m immediate >/dev/null\"", check=False)
    print(f"\nPASS {len(PASS)}")
    for p in PASS:
        print(f"  ok   {p}")
    if FAIL:
        print(f"FAIL {len(FAIL)}")
        for f in FAIL:
            print(f"  FAIL {f}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
