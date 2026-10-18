-- Data fix: the old client-side Change PIN re-keyed DEVIN's and FORD's teams to new
-- IDs but missed broadcasts / broadcast_acks. Point the leftover rows at each
-- team's current ID. Old IDs are matched by md5 so no ID/PIN value appears here.
-- Idempotent: once fixed, nothing matches and it does nothing.
-- Rollback: restore the 3 original rows from the backup taken before applying
-- (/workspace/aewfantasy-backup-20261018-123324-broadcasts/orphan_rows.json).

with map(old_md5, owner) as (values
  ('11ef1590a74e1ab26c31a4e13f52d71b', 'DEVIN'),
  ('80ca06abfa1a5104af9a770f485dad07', 'FORD'))
update public.broadcasts b set from_pin = t.pin
from map m join public.teams t on t.name = m.owner
where md5(lower(b.from_pin)) = m.old_md5
  and not exists (select 1 from public.teams x where x.pin = b.from_pin);

-- Read receipts: delete the old one if the current ID already acked the same
-- broadcast (primary key is broadcast_id + pin); otherwise re-point it.
with map(old_md5, owner) as (values
  ('11ef1590a74e1ab26c31a4e13f52d71b', 'DEVIN'),
  ('80ca06abfa1a5104af9a770f485dad07', 'FORD'))
delete from public.broadcast_acks a
using map m join public.teams t on t.name = m.owner
where md5(lower(a.pin)) = m.old_md5
  and not exists (select 1 from public.teams x where x.pin = a.pin)
  and exists (select 1 from public.broadcast_acks d where d.broadcast_id = a.broadcast_id and d.pin = t.pin);

with map(old_md5, owner) as (values
  ('11ef1590a74e1ab26c31a4e13f52d71b', 'DEVIN'),
  ('80ca06abfa1a5104af9a770f485dad07', 'FORD'))
update public.broadcast_acks a set pin = t.pin
from map m join public.teams t on t.name = m.owner
where md5(lower(a.pin)) = m.old_md5
  and not exists (select 1 from public.teams x where x.pin = a.pin);
