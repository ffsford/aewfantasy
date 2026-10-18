-- =============================================================================
-- Season name + Past Champions as data (settings rows, no schema change)
-- -----------------------------------------------------------------------------
-- * settings.season_name     : the current season's display name ("Season 9").
-- * settings.past_champions  : JSON array, same format as the old hard-coded list
--                              in app.js: [{"season": <n>, "name": "<champion>"}],
--                              plus an optional "label" for a custom season name.
-- Seeds exactly the entries that were hard-coded (Seasons 1-8) and the current
-- season name. ON CONFLICT DO NOTHING: never overwrites rows that already exist,
-- so it is safe to re-run and can't undo edits made in the app.
-- The app shows the same defaults when these rows are missing, so the order of
-- deploy vs. this seed doesn't matter.
-- =============================================================================
begin;

insert into public.settings (key, value) values
  ('season_name', 'Season 9'),
  ('past_champions',
   '[{"season":1,"name":"Devin"},{"season":2,"name":"Gally"},{"season":3,"name":"Stess"},{"season":4,"name":"Kamill"},{"season":5,"name":"Devin"},{"season":6,"name":"Evan"},{"season":7,"name":"Bito and Boti tag team"},{"season":8,"name":"Josh"}]')
on conflict (key) do nothing;

commit;

-- -----------------------------------------------------------------------------
-- Rollback (the app falls back to the built-in Season 9 / Seasons 1-8 defaults):
--   delete from public.settings where key in ('season_name', 'past_champions');
-- -----------------------------------------------------------------------------
