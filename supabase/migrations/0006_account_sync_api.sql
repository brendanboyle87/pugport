-- Apply only after clients have been upgraded. Older builds reject unknown kinds.
begin;
alter table public.records drop constraint records_kind_check;
alter table public.records add constraint records_kind_check check (
  kind in ('conversation','message','human-message','conversation-folder','project','memory','settings','remote-server','server-node','api-provider')
) NOT VALID;
-- Legacy device rows stay untouched and are ignored by upgraded clients.
-- NOT VALID enforces the new kinds on writes without scanning those old rows.
commit;
