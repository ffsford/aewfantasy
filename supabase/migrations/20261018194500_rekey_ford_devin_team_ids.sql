-- Data fix: give the FORD and DEVIN teams new, non-secret team IDs ('ford', 'devin').
-- Their old IDs were set by the old client-side Change PIN, so each old ID was the
-- owner's PIN, readable by anyone. The login secret (team_credentials.pin_hash) is
-- NOT changed: both owners keep logging in with the same PIN, and open sessions
-- follow the team (team_sessions.team_pin, ON UPDATE CASCADE).
-- Old IDs are matched only by owner name + md5, so no ID/PIN value is in this file.
-- One transaction (apply_migration wraps it). Idempotent: once re-keyed nothing
-- matches and it does nothing. Aborts if anything is unsafe or any reference is left.
-- Rollback: restore from the pre-apply backup
--   (/workspace/aewfantasy-backup-20261018-124016-rekey/rekey_rows.json) by running
--   this same procedure with new/old swapped.

do $$
declare
  r record;
  col_rec record;
  n bigint;
  v_left bigint := 0;
begin
  create temp table _rekey on commit drop as
    select t.pin as old_pin, m.new_pin, m.owner
    from (values ('FORD',  'ford',  '7dad4379546efd9686e7b0e23be5d612'),
                 ('DEVIN', 'devin', 'ce8fbf161182f814df5f778862afbedd')) m(owner, new_pin, old_md5)
    join public.teams t on t.name = m.owner and md5(lower(t.pin)) = m.old_md5;

  if not exists (select 1 from _rekey) then
    raise notice 'rekey: nothing to do';
    return;
  end if;

  -- Safety: new IDs must be free and must not be anyone's login PIN.
  if exists (select 1 from public.teams t join _rekey k on lower(t.pin) = k.new_pin) then
    raise exception 'rekey: new team ID already in use';
  end if;
  if exists (select 1 from public.team_credentials c, _rekey k
             where extensions.crypt(k.new_pin, c.pin_hash) = c.pin_hash) then
    raise exception 'rekey: new team ID equals a login PIN';
  end if;
  if exists (select 1 from public.drafts where status in ('active', 'paused')) then
    raise exception 'rekey: a draft is active or paused';
  end if;

  -- Draft tables have write guards; allow this transaction through them.
  perform set_config('aew.make_draft_pick', 'on', true);

  -- FKs without ON UPDATE CASCADE: drop now, re-add identically below.
  alter table public.claims drop constraint claims_pin_fkey;
  alter table public.foreign_objects drop constraint foreign_objects_pin_fkey;

  for r in select * from _rekey loop
    -- team_credentials / team_sessions follow via ON UPDATE CASCADE
    update public.teams            set pin = r.new_pin        where pin = r.old_pin;
    update public.claims           set pin = r.new_pin        where pin = r.old_pin;
    update public.foreign_objects  set pin = r.new_pin        where pin = r.old_pin;
    update public.fo_history       set pin = r.new_pin        where pin = r.old_pin;
    update public.trades           set from_pin = r.new_pin   where from_pin = r.old_pin;
    update public.trades           set to_pin = r.new_pin     where to_pin = r.old_pin;
    update public.draft_autopicks  set pin = r.new_pin        where pin = r.old_pin;
    update public.broadcasts       set from_pin = r.new_pin   where from_pin = r.old_pin;
    update public.broadcasts       set target = r.new_pin     where target = r.old_pin;
    update public.broadcast_acks   set pin = r.new_pin        where pin = r.old_pin;
    update public.trade_blocks     set pin = r.new_pin        where pin = r.old_pin;
    update public.show_imports     set approved_by = r.new_pin where approved_by = r.old_pin;
    update public.purge_log        set east_pin = r.new_pin   where east_pin = r.old_pin;
    update public.purge_log        set west_pin = r.new_pin   where west_pin = r.old_pin;
    update public.draft_picks      set pin = r.new_pin        where pin = r.old_pin;
    update public.drafts           set order_pins = array_replace(order_pins, r.old_pin, r.new_pin)
                                   where r.old_pin = any(order_pins);
    update public.settings         set key = 'claim_drops_' || r.new_pin
                                   where key = 'claim_drops_' || r.old_pin;
    -- The login PIN no longer equals the team ID (stops the "change your PIN" prompt).
    update public.team_credentials set pin_is_team_id = (extensions.crypt(r.new_pin, pin_hash) = pin_hash)
                                   where team_pin = r.new_pin;
  end loop;

  alter table public.claims add constraint claims_pin_fkey
    foreign key (pin) references public.teams(pin) on delete cascade;
  alter table public.foreign_objects add constraint foreign_objects_pin_fkey
    foreign key (pin) references public.teams(pin) on delete cascade;

  perform set_config('aew.make_draft_pick', '', true);

  -- Final check: no text/json/array column anywhere in public still contains an old ID.
  for col_rec in select col.table_name, col.column_name
           from information_schema.columns col
           join information_schema.tables tb on tb.table_schema = col.table_schema and tb.table_name = col.table_name and tb.table_type = 'BASE TABLE'
           where col.table_schema = 'public'
             and col.data_type in ('text', 'character varying', 'jsonb', 'json', 'ARRAY')
             and col.column_name not in ('pin_hash', 'token_hash') loop
    for r in select * from _rekey loop
      execute format('select count(*) from public.%I where %I::text ~* %L', col_rec.table_name, col_rec.column_name,
                     '(^|[^a-z0-9])' || r.old_pin || '([^a-z0-9]|$)') into n;
      v_left := v_left + n;
    end loop;
  end loop;
  if v_left > 0 then
    raise exception 'rekey: % reference(s) to an old ID remain; rolled back', v_left;
  end if;
end $$;
