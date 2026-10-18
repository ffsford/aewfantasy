-- Any number of divisions (Start New Season / Divisions panel / Season Lineup / Add Team)
--
-- Before: teams.division and drafts.division only allowed 'east' / 'west'.
-- After:  any division key the app generates: lowercase letters, digits and
--         underscores, 1-64 characters (teams.division may still be NULL = "Not playing").
--         'east' and 'west' are still valid, so the current season is untouched.
--
-- No existing row is changed. The new checks are validated against the current rows
-- inside this transaction; if any row did not fit, the whole migration rolls back.
--
-- purge_log gets one new nullable column, victims (jsonb), recording every division's
-- purged team as {"<division>": "<team id>"}. east_pin / west_pin are still written
-- exactly as before, so nothing that reads them changes.
--
-- ROLLBACK (only while every team/draft is still east/west/NULL):
--   alter table public.teams  drop constraint teams_division_check;
--   alter table public.drafts drop constraint drafts_division_check;
--   alter table public.teams  add constraint teams_division_check  check (division = any (array['east'::text, 'west'::text]));
--   alter table public.drafts add constraint drafts_division_check check (division = any (array['east'::text, 'west'::text]));
--   alter table public.purge_log drop column if exists victims;

set local lock_timeout = '5s';   -- never queue behind a long transaction; just fail and retry

do $$
begin
  if exists (select 1 from public.teams where division is not null and division !~ '^[a-z0-9_]{1,64}$') then
    raise exception 'teams has a division value that does not fit the new rule; nothing changed';
  end if;
  if exists (select 1 from public.drafts where division !~ '^[a-z0-9_]{1,64}$') then
    raise exception 'drafts has a division value that does not fit the new rule; nothing changed';
  end if;
end $$;

alter table public.teams  drop constraint if exists teams_division_check;
alter table public.drafts drop constraint if exists drafts_division_check;

-- Same constraint names as before, so the app's "division_check" detection still works.
alter table public.teams  add constraint teams_division_check
  check (division is null or division ~ '^[a-z0-9_]{1,64}$');
alter table public.drafts add constraint drafts_division_check
  check (division ~ '^[a-z0-9_]{1,64}$');

alter table public.purge_log add column if not exists victims jsonb;

comment on constraint teams_division_check on public.teams is
  'Division key (slug from settings.division_setup); NULL = not playing this season. Any number of divisions.';
comment on constraint drafts_division_check on public.drafts is
  'One drafts row per division key (slug from settings.division_setup).';
comment on column public.purge_log.victims is
  'Purged team per division: {"<division>": "<team id>"}. east_pin/west_pin kept for compatibility.';
