-- =============================================================================
-- Roster spots per team + prior-season points  (follow-up to 20261018171500_atomic_draft_pick)
-- -----------------------------------------------------------------------------
-- * make_draft_pick(): number of rounds = settings.roster_spots (1..30), else 8.
-- * make_draft_pick(): draft completion writes rosters but no longer overwrites the
--   roster cap (unless roster_spots is missing -> legacy cap 8) and no longer zeroes
--   wrestler points (Start New Season now archives them into prior_points).
-- * Best-available autopick ranks by prior_points with a clear NULL rule.
-- * wrestler_points.prior_points becomes nullable (NULL = not recorded). If the column
--   was never filled in (every value 0), those zeros become NULL. If any non-zero
--   prior points exist, nothing is converted (zeros are then real zeros).
-- Same function signature and result codes as before. Safe to re-run.
-- =============================================================================

begin;

alter table public.wrestler_points alter column prior_points drop not null;
alter table public.wrestler_points alter column prior_points set default null;
do $$
begin
  if not exists (select 1 from public.wrestler_points where prior_points is not null and prior_points <> 0) then
    update public.wrestler_points set prior_points = null where prior_points = 0;
  end if;
end $$;

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
  c_rounds   integer := 8;                    -- = settings.roster_spots (1..30), else 8; same as getDraftRounds() in app.js
  v_spots_set boolean := false;
  v_spots_raw text;
  v_prior_populated boolean;
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
-- Rollback: re-run supabase/migrations/20261018171500_atomic_draft_pick.sql section 2
-- (the previous make_draft_pick body: fixed 8 rounds, sets max_roster = 8 and zeroes
-- points at completion). prior_points can stay nullable; the previous function
-- treats NULL the same as 0 via coalesce(nullif(prior,0), points, 0).
-- -----------------------------------------------------------------------------
