-- =============================================================================
-- PIN security, phase 1: PINs become real secrets, logins use session tokens
-- -----------------------------------------------------------------------------
-- Background: teams.pin is the team's PRIMARY KEY and is referenced by 14 columns
-- in 12 tables (claims, trades, draft_picks, drafts.order_pins, broadcasts, ...),
-- settings keys (claim_drops_<pin>) and values (fantasy_champion). It is therefore
-- public no matter what grants say, and 12 of 14 PINs equal the team name. So this
-- migration does NOT try to hide teams.pin. Instead:
--   * teams.pin stays as the team's public ID (values unchanged, nothing re-keyed).
--   * The login secret moves to team_credentials.pin_hash (bcrypt, unreadable by
--     anon/authenticated). Seeded with each team's CURRENT PIN, so everyone logs in
--     exactly as today. Once an owner changes their PIN, only the hash changes; the
--     public ID stays, and the old PIN stops working.
--   * login_with_pin() returns the team identity + an opaque session token (only its
--     sha256 is stored, 90-day sliding expiry). Wrong PIN reveals nothing.
--   * make_draft_pick() authenticates with the session token (same signature).
--   * PIN change, commissioner PIN reset, Add Team and Delete Team go through
--     token-checked RPCs. Direct INSERT/DELETE on teams, and UPDATE of teams.pin /
--     teams.is_commissioner, are revoked from anon and authenticated. Other column
--     updates stay as today (in-season writes are phase 2).
-- Requires pgcrypto in schema "extensions" (installed on Supabase by default).
-- Safe to re-run. Rollback at the bottom.
-- =============================================================================
begin;

create extension if not exists pgcrypto with schema extensions;

-- ---------- 1. Tables (no access for anon/authenticated; RLS on, no policies) ----------
create table if not exists public.team_credentials (
  team_pin       text primary key references public.teams(pin) on update cascade on delete cascade,
  pin_hash       text not null,
  pin_is_team_id boolean not null default false,   -- true = login PIN still equals the public team ID
  updated_at     timestamptz not null default now()
);
create table if not exists public.team_sessions (
  token_hash   text primary key,                    -- sha256(token); the token itself is never stored
  team_pin     text not null references public.teams(pin) on update cascade on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index if not exists team_sessions_team_pin_idx on public.team_sessions (team_pin);
create table if not exists public.login_failures (
  id bigserial primary key,
  at timestamptz not null default now()
);
create index if not exists login_failures_at_idx on public.login_failures (at);

alter table public.team_credentials enable row level security;
alter table public.team_sessions    enable row level security;
alter table public.login_failures   enable row level security;
revoke all on public.team_credentials, public.team_sessions, public.login_failures from public, anon, authenticated;
revoke all on sequence public.login_failures_id_seq from public, anon, authenticated;

-- Seed: every existing team logs in with its current PIN (only teams without a credential).
insert into public.team_credentials (team_pin, pin_hash, pin_is_team_id)
select t.pin, extensions.crypt(lower(t.pin), extensions.gen_salt('bf', 8)), true
  from public.teams t
on conflict (team_pin) do nothing;

-- A team row created outside the app (SQL editor / service role) gets a legacy
-- credential = its ID, exactly like today, so it can still log in.
create or replace function public.teams_default_credential()
returns trigger language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  insert into public.team_credentials (team_pin, pin_hash, pin_is_team_id)
  values (new.pin, extensions.crypt(lower(new.pin), extensions.gen_salt('bf', 8)), true)
  on conflict (team_pin) do nothing;
  return new;
end $$;
revoke all on function public.teams_default_credential() from public, anon, authenticated;
drop trigger if exists teams_default_credential on public.teams;
create trigger teams_default_credential after insert on public.teams
  for each row execute function public.teams_default_credential();

-- Old pages created teams / changed PINs with direct writes (the old Change PIN
-- re-keyed the team row). Those now go through the RPCs below.
revoke insert, delete, truncate on public.teams from anon, authenticated;
-- No page ever updates a team's ID or commissioner flag, so lock those two columns
-- (stops "make yourself commissioner" via a direct write). All other columns stay
-- updatable exactly as today (in-season writes are phase 2).
revoke update on public.teams from anon, authenticated;
grant update (name, team_name, division, max_roster, roster, points, last_delta, purged) on public.teams to anon, authenticated;

-- ---------- 2. Internal helpers (not callable by clients) ----------
create or replace function public.aew_token_hash(p_token text)
returns text language sql immutable set search_path = public, extensions, pg_temp as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;
revoke all on function public.aew_token_hash(text) from public, anon, authenticated;

-- The team behind a live session token (null when missing/expired).
create or replace function public.aew_session_team(p_token text)
returns public.teams language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select t.* from public.team_sessions s join public.teams t on t.pin = s.team_pin
   where s.token_hash = public.aew_token_hash(p_token) and s.expires_at > now()
   limit 1
$$;
revoke all on function public.aew_session_team(text) from public, anon, authenticated;

-- Which team (if any) already uses this PIN as its login secret.
create or replace function public.aew_pin_owner(p_pin text)
returns text language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select c.team_pin from public.team_credentials c
   where c.pin_hash = extensions.crypt(lower(trim(coalesce(p_pin, ''))), c.pin_hash)
   limit 1
$$;
revoke all on function public.aew_pin_owner(text) from public, anon, authenticated;

-- Rules for a NEW PIN. Returns null when OK, else { code, message }.
-- Team IDs and names are public, so they can't be used as a PIN.
create or replace function public.aew_new_pin_problem(p_pin text, p_for_team text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare v text := lower(trim(coalesce(p_pin, ''))); v_owner text;
begin
  if v !~ '^[a-z0-9]{4,10}$' then
    return jsonb_build_object('code', 'bad_format', 'message', 'PIN must be 4–10 letters or numbers, no spaces or symbols.');
  end if;
  if v = 'doublej' or exists (select 1 from public.teams t
       where lower(t.pin) = v or lower(regexp_replace(coalesce(t.name, ''), '[^A-Za-z0-9]', '', 'g')) = v
          or lower(regexp_replace(coalesce(t.team_name, ''), '[^A-Za-z0-9]', '', 'g')) = v) then
    return jsonb_build_object('code', 'public_pin', 'message', 'That PIN is a team name or team ID that everyone can see. Choose something only you know.');
  end if;
  v_owner := public.aew_pin_owner(v);
  if v_owner is not null and v_owner = p_for_team then
    return jsonb_build_object('code', 'same_pin', 'message', 'That is already your PIN.');
  elsif v_owner is not null then
    return jsonb_build_object('code', 'taken', 'message', 'That PIN is already taken. Choose another.');
  end if;
  return null;
end $$;
revoke all on function public.aew_new_pin_problem(text, text) from public, anon, authenticated;

create or replace function public.aew_new_session(p_team text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_token text := 'aews_' || encode(extensions.gen_random_bytes(32), 'hex'); v_exp timestamptz := now() + interval '90 days';
begin
  delete from public.team_sessions where expires_at < now();
  insert into public.team_sessions (token_hash, team_pin, expires_at) values (public.aew_token_hash(v_token), p_team, v_exp);
  return jsonb_build_object('token', v_token, 'expires_at', v_exp);
end $$;
revoke all on function public.aew_new_session(text) from public, anon, authenticated;

create or replace function public.aew_identity(t public.teams)
returns jsonb language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object('ok', true, 'team', t.pin, 'name', t.name, 'is_commissioner', coalesce(t.is_commissioner, false),
    'pin_is_team_id', coalesce((select c.pin_is_team_id from public.team_credentials c where c.team_pin = t.pin), false))
$$;
revoke all on function public.aew_identity(public.teams) from public, anon, authenticated;

-- ---------- 3. Client RPCs ----------
-- Log in. Wrong PIN -> { ok:false, code:'bad_pin' } and nothing else.
create or replace function public.login_with_pin(p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v text := lower(trim(coalesce(p_pin, ''))); v_team text; t public.teams%rowtype;
begin
  if v !~ '^[a-z0-9]{1,10}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_format', 'message', 'PIN must be 1-10 letters or numbers only');
  end if;
  if v = 'doublej' then                           -- read-only viewer: no session, no rights
    return jsonb_build_object('ok', true, 'viewer', true, 'team', 'doublej', 'name', 'Double J');
  end if;
  if (select count(*) from public.login_failures where at > now() - interval '10 minutes') >= 60 then
    return jsonb_build_object('ok', false, 'code', 'too_many', 'message', 'Too many wrong PINs. Wait a few minutes and try again.');
  end if;
  v_team := public.aew_pin_owner(v);
  if v_team is null then
    insert into public.login_failures default values;
    delete from public.login_failures where at < now() - interval '1 day';
    return jsonb_build_object('ok', false, 'code', 'bad_pin', 'message', 'Wrong PIN.');
  end if;
  select * into t from public.teams where pin = v_team;
  return public.aew_identity(t) || public.aew_new_session(v_team);
end $$;

-- Who am I? (page reload). Slides the 90-day expiry at most once a day.
create or replace function public.session_info(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare t public.teams%rowtype;
begin
  t := public.aew_session_team(p_token);
  if t.pin is null then
    return jsonb_build_object('ok', false, 'code', 'no_session', 'message', 'Please log in.');
  end if;
  update public.team_sessions set last_seen_at = now(), expires_at = now() + interval '90 days'
   where token_hash = public.aew_token_hash(p_token) and last_seen_at < now() - interval '1 day';
  return public.aew_identity(t);
end $$;

create or replace function public.logout_session(p_token text)
returns jsonb language sql security definer set search_path = public, extensions, pg_temp as $$
  with d as (delete from public.team_sessions where token_hash = public.aew_token_hash(p_token) returning 1)
  select jsonb_build_object('ok', true, 'ended', (select count(*) from d))
$$;

-- Owner changes their own PIN (valid session required; old PIN optional extra check).
-- Other logins of that team are signed out.
create or replace function public.change_my_pin(p_token text, p_new_pin text, p_old_pin text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare t public.teams%rowtype; v_problem jsonb;
begin
  t := public.aew_session_team(p_token);
  if t.pin is null then
    return jsonb_build_object('ok', false, 'code', 'no_session', 'message', 'Your login has expired. Log out and log in again.');
  end if;
  if p_old_pin is not null and coalesce(public.aew_pin_owner(p_old_pin), '') <> t.pin then
    return jsonb_build_object('ok', false, 'code', 'bad_old_pin', 'message', 'Your current PIN is not right.');
  end if;
  v_problem := public.aew_new_pin_problem(p_new_pin, t.pin);
  if v_problem is not null then return jsonb_build_object('ok', false) || v_problem; end if;
  update public.team_credentials
     set pin_hash = extensions.crypt(lower(trim(p_new_pin)), extensions.gen_salt('bf', 8)), pin_is_team_id = false, updated_at = now()
   where team_pin = t.pin;
  delete from public.team_sessions where team_pin = t.pin and token_hash <> public.aew_token_hash(p_token);
  return jsonb_build_object('ok', true, 'team', t.pin);
end $$;

-- Commissioner sets a team's PIN (forgotten PIN). That team's logins are signed out.
create or replace function public.commish_set_team_pin(p_token text, p_team text, p_new_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare c public.teams%rowtype; v_problem jsonb; v_team text := lower(trim(coalesce(p_team, '')));
begin
  c := public.aew_session_team(p_token);
  if c.pin is null or not coalesce(c.is_commissioner, false) then
    return jsonb_build_object('ok', false, 'code', 'not_commissioner', 'message', 'Only the commissioner can reset PINs. Log in again if you are.');
  end if;
  if not exists (select 1 from public.teams where pin = v_team) then
    return jsonb_build_object('ok', false, 'code', 'no_team', 'message', 'Team not found.');
  end if;
  v_problem := public.aew_new_pin_problem(p_new_pin, v_team);
  if v_problem is not null and v_problem->>'code' <> 'same_pin' then return jsonb_build_object('ok', false) || v_problem; end if;
  insert into public.team_credentials (team_pin, pin_hash, pin_is_team_id, updated_at)
  values (v_team, extensions.crypt(lower(trim(p_new_pin)), extensions.gen_salt('bf', 8)), false, now())
  on conflict (team_pin) do update set pin_hash = excluded.pin_hash, pin_is_team_id = false, updated_at = now();
  delete from public.team_sessions where team_pin = v_team and token_hash <> public.aew_token_hash(p_token);
  return jsonb_build_object('ok', true, 'team', v_team);
end $$;

-- Commissioner adds a team. The team's public ID is made from its name (never the PIN).
create or replace function public.add_league_team(p_token text, p_name text, p_pin text, p_division text default null, p_max_roster integer default 8)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare c public.teams%rowtype; v_problem jsonb; v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
        v_base text; v_id text; i integer := 1;
begin
  c := public.aew_session_team(p_token);
  if c.pin is null or not coalesce(c.is_commissioner, false) then
    return jsonb_build_object('ok', false, 'code', 'not_commissioner', 'message', 'Only the commissioner can add teams. Log in again if you are.');
  end if;
  if v_name = '' or length(v_name) > 40 then
    return jsonb_build_object('ok', false, 'code', 'bad_name', 'message', 'Enter the owner name (up to 40 characters).');
  end if;
  v_problem := public.aew_new_pin_problem(p_pin, null);
  if v_problem is not null then return jsonb_build_object('ok', false) || v_problem; end if;
  if lower(regexp_replace(v_name, '[^A-Za-z0-9]', '', 'g')) = lower(trim(p_pin)) then
    return jsonb_build_object('ok', false, 'code', 'public_pin', 'message', 'The PIN can''t be the owner''s name. Choose something only they will know.');
  end if;
  v_base := left(lower(regexp_replace(v_name, '[^A-Za-z0-9]', '', 'g')), 8);
  if v_base = '' then v_base := 'team'; end if;
  v_id := v_base;
  while v_id = 'doublej' or v_id = lower(trim(p_pin)) or exists (select 1 from public.teams where pin = v_id)
        or public.aew_pin_owner(v_id) is not null loop
    i := i + 1; v_id := v_base || i;
  end loop;
  begin
    insert into public.teams (pin, name, division, is_commissioner, max_roster, roster, points, last_delta, purged)
    values (v_id, v_name, nullif(p_division, ''), false, greatest(1, least(coalesce(p_max_roster, 8), 30)), '{}', 0, null, false);
  exception when check_violation then
    return jsonb_build_object('ok', false, 'code', 'division_check', 'message', 'That division is not allowed yet: ' || sqlerrm);
  end;
  update public.team_credentials
     set pin_hash = extensions.crypt(lower(trim(p_pin)), extensions.gen_salt('bf', 8)), pin_is_team_id = false, updated_at = now()
   where team_pin = v_id;
  return jsonb_build_object('ok', true, 'team', v_id, 'name', v_name);
end $$;

-- Commissioner deletes a team that is not playing (same rule as the app).
create or replace function public.delete_league_team(p_token text, p_team text)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare c public.teams%rowtype; t public.teams%rowtype;
begin
  c := public.aew_session_team(p_token);
  if c.pin is null or not coalesce(c.is_commissioner, false) then
    return jsonb_build_object('ok', false, 'code', 'not_commissioner', 'message', 'Only the commissioner can delete teams. Log in again if you are.');
  end if;
  select * into t from public.teams where pin = lower(trim(coalesce(p_team, '')));
  if not found then return jsonb_build_object('ok', false, 'code', 'no_team', 'message', 'Team not found.'); end if;
  if t.division is not null or coalesce(t.is_commissioner, false) then
    return jsonb_build_object('ok', false, 'code', 'still_playing', 'message', 'Set the team to "Not playing" first.');
  end if;
  delete from public.teams where pin = t.pin;
  return jsonb_build_object('ok', true, 'team', t.pin);
end $$;

revoke all on function public.login_with_pin(text), public.session_info(text), public.logout_session(text),
  public.change_my_pin(text, text, text), public.commish_set_team_pin(text, text, text),
  public.add_league_team(text, text, text, text, integer), public.delete_league_team(text, text) from public;
grant execute on function public.login_with_pin(text), public.session_info(text), public.logout_session(text),
  public.change_my_pin(text, text, text), public.commish_set_team_pin(text, text, text),
  public.add_league_team(text, text, text, text, integer), public.delete_league_team(text, text)
  to anon, authenticated, service_role;

-- ---------- 4. make_draft_pick: session token instead of PIN (same signature + result codes) ----------
create or replace function public.make_draft_pick(
  p_division    text,
  p_pick_number integer,          -- 1-based: the pick the caller is looking at (drafts.current_pick + 1)
  p_pin         text,             -- caller's SESSION TOKEN from login_with_pin() (name kept so old pages get a clear 'reload' message)
  p_wrestler    text    default null,  -- required for manual picks, ignored for autopicks
  p_is_autopick boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  c_rounds   integer := 8;                    -- = settings.roster_spots (1..30), else 8; same as getDraftRounds() in app.js
  v_spots_set boolean := false;
  v_spots_raw text;
  v_prior_populated boolean;
  v_token    text := trim(coalesce(p_pin, ''));
  v_caller   public.teams%rowtype;
  v_draft    public.drafts%rowtype;
  v_n        integer;
  v_total    integer;
  v_idx      integer;
  v_round    integer;
  v_pos      integer;
  v_on_clock text;
  v_shared   boolean;
  v_mode     text;
  v_setup    jsonb;
  v_divcount integer;
  v_chosen   text;
  v_taken_in text;
  v_done     boolean;
  v_reset    boolean := false;
begin
  -- Who is calling? A live session token from login_with_pin(). A raw PIN (sent by
  -- a page loaded before this update) is refused with a 'reload' message.
  select t.* into v_caller
    from public.team_sessions s join public.teams t on t.pin = s.team_pin
   where s.token_hash = public.aew_token_hash(v_token) and s.expires_at > now();
  if not found then
    if v_token ~ '^[A-Za-z0-9]{1,10}$' then
      return jsonb_build_object('ok', false, 'code', 'reload_required',
        'message', 'This page is out of date. Reload the page and log in again to make picks.');
    end if;
    return jsonb_build_object('ok', false, 'code', 'bad_session',
      'message', 'Your login has expired. Log out and log in again.');
  end if;

  -- Roster mode (mirrors isSharedRosterPool() in app.js): one division is always
  -- shared; otherwise settings.roster_mode = 'shared' | anything else = separate.
  select value into v_mode from public.settings where key = 'roster_mode';
  begin
    select value::jsonb into v_setup from public.settings where key = 'division_setup';
  exception when others then
    v_setup := null;                         -- unreadable JSON: treat as not set
  end;
  if v_setup is not null and coalesce((v_setup->>'count') ~ '^\d+$', false) and (v_setup->>'count')::int >= 1 then
    v_divcount := (v_setup->>'count')::int;
  else
    select count(distinct division) into v_divcount from public.teams where division is not null;
    if v_divcount = 0 then v_divcount := 2; end if;
  end if;
  v_shared := (v_divcount = 1) or (coalesce(v_mode, '') = 'shared');

  -- Draft rounds = roster spots per team chosen at Start New Season.
  -- Missing or invalid setting = 8 (the original fixed number of rounds).
  select trim(value) into v_spots_raw from public.settings where key = 'roster_spots';
  if v_spots_raw ~ '^\d{1,2}$' and v_spots_raw::int between 1 and 30 then
    c_rounds := v_spots_raw::int;
    v_spots_set := true;
  end if;

  -- Lock. Shared roster: every division's draft can take the same wrestler, so
  -- serialize ALL drafts (rows locked in a fixed order -> no deadlocks).
  -- Separate rosters: only this division's row.
  if v_shared then
    perform 1 from public.drafts order by division for update;
  end if;
  select * into v_draft from public.drafts where division = p_division for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_draft', 'message', 'No draft exists for this division.');
  end if;

  if v_draft.status is distinct from 'active' then
    return jsonb_build_object('ok', false, 'code', 'not_active', 'status', v_draft.status,
      'message', 'The draft is not active (' || coalesce(v_draft.status, 'idle') || ').');
  end if;

  v_n := coalesce(array_length(v_draft.order_pins, 1), 0);
  if v_n = 0 or not coalesce(v_draft.order_locked, false) then
    return jsonb_build_object('ok', false, 'code', 'no_order', 'message', 'The draft order is not locked.');
  end if;
  v_total := v_n * c_rounds;
  v_idx   := coalesce(v_draft.current_pick, 0);
  if v_idx >= v_total then
    return jsonb_build_object('ok', false, 'code', 'draft_complete', 'message', 'The draft is already complete.');
  end if;

  if p_pick_number is distinct from v_idx + 1 then
    return jsonb_build_object('ok', false, 'code', 'stale_pick', 'current_pick_number', v_idx + 1,
      'message', 'That pick was already made. The board has moved on.');
  end if;

  -- Snake order (same as getSnakePin in app.js): even rounds forward, odd reverse.
  v_round := v_idx / v_n;
  v_pos   := v_idx % v_n;
  if v_round % 2 = 0 then
    v_on_clock := v_draft.order_pins[v_pos + 1];
  else
    v_on_clock := v_draft.order_pins[v_n - v_pos];
  end if;
  v_on_clock := lower(trim(v_on_clock));

  -- Authorization
  if not coalesce(p_is_autopick, false) then
    if v_caller.pin <> v_on_clock and not coalesce(v_caller.is_commissioner, false) then
      return jsonb_build_object('ok', false, 'code', 'not_your_turn',
        'message', 'It is not your turn.');
    end if;
  end if;
  -- Autopick: any league PIN may trigger it (absent-owner autopick runs in every
  -- open browser), but the SERVER chooses the wrestler below.

  -- Choose / validate the wrestler. Names are compared case-insensitively.
  if coalesce(p_is_autopick, false) then
    -- 1) on-clock owner's ranked autopick list, in order
    select m.name into v_chosen
    from public.draft_autopicks a
    cross join lateral unnest(a.ranked) with ordinality as r(name, ord)
    join public.master_roster m on lower(trim(m.name)) = lower(trim(r.name))
    where a.pin = v_on_clock
      and not exists (select 1 from public.draft_picks dp
                      where lower(trim(dp.wrestler)) = lower(trim(m.name))
                        and (v_shared or dp.division = p_division))
    order by r.ord
    limit 1;
    -- 2) best available by prior-season points (same rule as getDraftPts in app.js):
    --    a stored prior_points counts, including a real 0, once the league has any
    --    non-zero prior points; NULL / no row (or a never-filled all-zero column)
    --    falls back to current season points.
    if v_chosen is null then
      v_prior_populated := exists (select 1 from public.wrestler_points
                                   where prior_points is not null and prior_points <> 0);
      select m.name into v_chosen
      from public.master_roster m
      left join public.wrestler_points wp on lower(trim(wp.name)) = lower(trim(m.name))
      where not exists (select 1 from public.draft_picks dp
                        where lower(trim(dp.wrestler)) = lower(trim(m.name))
                          and (v_shared or dp.division = p_division))
      order by (case when wp.prior_points is not null and (v_prior_populated or wp.prior_points <> 0)
                     then wp.prior_points
                     else coalesce(wp.points, 0) end) desc,
               lower(m.name) asc
      limit 1;
    end if;
    if v_chosen is null then
      return jsonb_build_object('ok', false, 'code', 'pool_empty', 'message', 'No wrestlers left to pick.');
    end if;
  else
    if p_wrestler is null or trim(p_wrestler) = '' then
      return jsonb_build_object('ok', false, 'code', 'no_wrestler', 'message', 'Choose a wrestler.');
    end if;
    select m.name into v_chosen from public.master_roster m
    where lower(trim(m.name)) = lower(trim(p_wrestler)) limit 1;
    if v_chosen is null then
      return jsonb_build_object('ok', false, 'code', 'not_in_pool', 'message', 'That wrestler is not in the draft pool.');
    end if;
    select dp.division into v_taken_in from public.draft_picks dp
    where lower(trim(dp.wrestler)) = lower(trim(v_chosen))
      and (v_shared or dp.division = p_division)
    limit 1;
    if v_taken_in is not null then
      return jsonb_build_object('ok', false, 'code', 'already_taken', 'taken_in_division', v_taken_in,
        'shared', v_shared, 'message', v_chosen || ' has already been drafted.');
    end if;
  end if;

  -- Write: lets the guard triggers (section 3) know this is the sanctioned path.
  perform set_config('aew.make_draft_pick', 'on', true);

  insert into public.draft_picks (division, pick_number, round, pin, wrestler, is_auto)
  values (p_division, v_idx + 1, v_round + 1, v_on_clock, v_chosen, coalesce(p_is_autopick, false));

  v_done := (v_idx + 1) >= v_total;
  update public.drafts
     set current_pick = v_idx + 1,
         status       = case when v_done then 'complete' else 'active' end,
         updated_at   = now()
   where division = p_division;

  if v_done then
    -- Final rosters: picks in order. The roster CAP comes from the season setting
    -- (Start New Season set every team's max_roster), so it is not touched here.
    -- Legacy: with no roster_spots setting the cap is set to 8 exactly as before.
    update public.teams t
       set roster = r.roster,
           max_roster = case when v_spots_set then t.max_roster else c_rounds end
      from (select pin, array_agg(wrestler order by pick_number) as roster
              from public.draft_picks
             where division = p_division and wrestler is not null
             group by pin) r
     where t.pin = r.pin;
    -- Wrestler points are NOT zeroed here any more. Start New Season saves them as
    -- prior-season points and resets them; 'points_reset' stays in the result as false.
  end if;

  perform set_config('aew.make_draft_pick', 'off', true);

  return jsonb_build_object(
    'ok', true, 'code', 'ok',
    'division', p_division, 'pick_number', v_idx + 1, 'round', v_round + 1,
    'team', (select coalesce(nullif(trim(team_name), ''), name) from public.teams where pin = v_on_clock),
    'wrestler', v_chosen, 'is_auto', coalesce(p_is_autopick, false),
    'completed', v_done, 'points_reset', v_reset);
end;
$$;

revoke all on function public.make_draft_pick(text, integer, text, text, boolean) from public;
grant execute on function public.make_draft_pick(text, integer, text, text, boolean) to anon, authenticated, service_role;

commit;

-- -----------------------------------------------------------------------------
-- Rollback (logins go back to "PIN = team ID"; PINs changed after this update are lost):
--   begin;
--   -- re-run the make_draft_pick section of 20261018180000_roster_spots_prior_points.sql
--   drop function if exists public.login_with_pin(text), public.session_info(text), public.logout_session(text),
--     public.change_my_pin(text, text, text), public.commish_set_team_pin(text, text, text),
--     public.add_league_team(text, text, text, text, integer), public.delete_league_team(text, text),
--     public.aew_identity(public.teams), public.aew_new_session(text), public.aew_new_pin_problem(text, text),
--     public.aew_pin_owner(text), public.aew_session_team(text);
--   drop trigger if exists teams_default_credential on public.teams;
--   drop function if exists public.teams_default_credential();
--   drop table if exists public.team_sessions, public.team_credentials, public.login_failures;
--   -- (after make_draft_pick is restored, aew_token_hash is unused)
--   drop function if exists public.aew_token_hash(text);
--   grant insert, delete, truncate, update on public.teams to anon, authenticated;
--   commit;
-- -----------------------------------------------------------------------------
