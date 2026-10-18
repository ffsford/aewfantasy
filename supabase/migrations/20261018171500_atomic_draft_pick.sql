-- =============================================================================
-- Atomic, server-side draft picks
-- -----------------------------------------------------------------------------
-- Before this migration the browser decided whose turn it was and wrote the pick
-- itself (insert into draft_picks, then advance drafts.current_pick). Two clients
-- could race, a crash between the two writes could stall the draft, and anyone
-- with the public anon key could insert any pick.
--
-- After it, every pick (manual, commissioner, Force Autopick, absent-owner
-- autopick) goes through public.make_draft_pick(), which in ONE transaction:
--   locks the draft row(s) -> checks status / pick number / whose turn ->
--   checks the PIN -> checks the wrestler (pool + not taken, roster-mode aware) ->
--   inserts the pick -> advances the counter -> on the last pick marks the draft
--   complete, writes the final rosters and (when every draft is done) zeroes
--   wrestler points.
--
-- Direct client writes that could bypass it are closed off (section 4).
-- Safe to re-run.
-- =============================================================================

begin;

-- 1) Prior-season points column (the app already reads/writes it and falls back
--    when it is missing; the live table does not have it yet). Used by autopick's
--    "best available" ranking: prior-season points if non-zero, else current.
alter table public.wrestler_points
  add column if not exists prior_points integer not null default 0;

-- 2) The pick function ---------------------------------------------------------
create or replace function public.make_draft_pick(
  p_division    text,
  p_pick_number integer,          -- 1-based: the pick the caller is looking at (drafts.current_pick + 1)
  p_pin         text,             -- caller's league PIN
  p_wrestler    text    default null,  -- required for manual picks, ignored for autopicks
  p_is_autopick boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_rounds   constant integer := 8;          -- must match DRAFT_ROUNDS in app.js
  v_pin      text := lower(trim(coalesce(p_pin, '')));
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
  -- Who is calling? (PIN-in-request is the app's existing auth model.)
  if v_pin = '' or v_pin = 'doublej' then
    return jsonb_build_object('ok', false, 'code', 'bad_pin', 'message', 'This PIN cannot make draft picks.');
  end if;
  select * into v_caller from public.teams where lower(pin) = v_pin;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'bad_pin', 'message', 'Unknown PIN.');
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
    -- 2) best available: prior-season points if non-zero, else current points
    if v_chosen is null then
      select m.name into v_chosen
      from public.master_roster m
      left join public.wrestler_points wp on lower(trim(wp.name)) = lower(trim(m.name))
      where not exists (select 1 from public.draft_picks dp
                        where lower(trim(dp.wrestler)) = lower(trim(m.name))
                          and (v_shared or dp.division = p_division))
      order by coalesce(nullif(wp.prior_points, 0), wp.points, 0) desc, m.name asc
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
    -- Final rosters (same as finalizeDraftRosters in app.js): picks in order, max 8
    update public.teams t
       set roster = r.roster, max_roster = c_rounds
      from (select pin, array_agg(wrestler order by pick_number) as roster
              from public.draft_picks
             where division = p_division and wrestler is not null
             group by pin) r
     where t.pin = r.pin;

    -- When no draft is still running, wipe points for the new season
    -- (same rule as maybeResetPointsAfterAllDraftsComplete in app.js).
    if not exists (select 1 from public.drafts where status in ('active', 'paused')) then
      update public.wrestler_points set points = 0 where name <> '';
      v_reset := true;
    end if;
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

-- 3) Guard triggers: invariants that hold for EVERY writer (anon, edge functions)
--    except make_draft_pick itself. They leave Start Draft, Pause/Resume, the
--    schedule reset, the Draft Fight lock, Start New Season and rapid-task working.
create or replace function public.drafts_write_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('aew.make_draft_pick', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(new.current_pick, 0) <> 0 or new.status = 'complete' then
      raise exception 'New drafts must start at pick 0 and not complete'
        using errcode = '42501', hint = 'Picks are made only through make_draft_pick().';
    end if;
    return new;
  end if;
  -- UPDATE: resetting the counter to 0 is fine (Start Draft / resets); moving it anywhere else is not.
  if new.current_pick is distinct from old.current_pick and coalesce(new.current_pick, 0) <> 0 then
    raise exception 'drafts.current_pick can only advance through make_draft_pick()'
      using errcode = '42501';
  end if;
  if new.status = 'complete' and old.status is distinct from 'complete' then
    raise exception 'A draft is marked complete only by its last pick (make_draft_pick())'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists drafts_write_guard on public.drafts;
create trigger drafts_write_guard
  before insert or update on public.drafts
  for each row execute function public.drafts_write_guard();

create or replace function public.draft_picks_write_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  if current_setting('aew.make_draft_pick', true) = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Draft picks are made only through make_draft_pick()' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    -- Only the wrestler name may change (commissioner "rename wrestler" fixes spellings)
    if (new.division, new.pick_number, new.round, new.pin, new.is_auto)
       is distinct from (old.division, old.pick_number, old.round, old.pin, old.is_auto) then
      raise exception 'Only draft_picks.wrestler (renames) may be edited' using errcode = '42501';
    end if;
    return new;
  end if;
  -- DELETE: allowed for resets, but never while that division's draft is running
  select status into v_status from public.drafts where division = old.division;
  if v_status in ('active', 'paused') then
    raise exception 'Cannot delete picks while the % draft is %', old.division, v_status using errcode = '42501';
  end if;
  return old;
end;
$$;

drop trigger if exists draft_picks_write_guard on public.draft_picks;
create trigger draft_picks_write_guard
  before insert or update or delete on public.draft_picks
  for each row execute function public.draft_picks_write_guard();

-- 4) Privileges: the browser (anon / authenticated) may no longer INSERT picks or
--    TRUNCATE the draft tables (TRUNCATE skips row triggers). It keeps
--    SELECT, DELETE (resets; guarded above) and UPDATE (renames; guarded above)
--    on draft_picks, and SELECT/INSERT/UPDATE/DELETE on drafts (guarded above).
revoke insert, truncate on public.draft_picks from anon, authenticated;
revoke truncate on public.drafts from anon, authenticated;

commit;

-- -----------------------------------------------------------------------------
-- Rollback (if ever needed):
--   begin;
--   drop trigger if exists draft_picks_write_guard on public.draft_picks;
--   drop trigger if exists drafts_write_guard on public.drafts;
--   drop function if exists public.draft_picks_write_guard();
--   drop function if exists public.drafts_write_guard();
--   drop function if exists public.make_draft_pick(text, integer, text, text, boolean);
--   grant insert, truncate on public.draft_picks to anon, authenticated;
--   grant truncate on public.drafts to anon, authenticated;
--   commit;
--   (prior_points is harmless to keep; the app already uses it.)
-- -----------------------------------------------------------------------------
