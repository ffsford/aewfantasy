-- One row per wrestler regardless of capitals (applied live Oct 22 2026 after merging 111 duplicate pairs)
create unique index if not exists wrestler_points_name_ci_unique on public.wrestler_points (lower(trim(name)));
