-- 008: Drive folder index — one row per service-report folder
-- Filled by scripts/drive_index.py (GitHub Actions).
-- Folder names look like "2026-07-21 호 BWTS PRU 하륙 수리 요청의 건",
-- living under "<no>. <SHIP>" inside the BWTS / EGCS report trees.
-- Run once in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS drive_folders (
  id          TEXT PRIMARY KEY,   -- Drive folder id
  ship_code   TEXT NOT NULL,
  system      TEXT NOT NULL,      -- BWTS | EGCS
  folder_date DATE,               -- leading YYYY-MM-DD of the name
  title       TEXT DEFAULT '',    -- name without the date prefix
  name        TEXT NOT NULL,      -- raw folder name
  url         TEXT NOT NULL,
  parent_id   TEXT NOT NULL,      -- the ship folder
  indexed_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drive_folders_ship_idx
  ON drive_folders (ship_code, system);
CREATE INDEX IF NOT EXISTS drive_folders_date_idx
  ON drive_folders (folder_date);

ALTER TABLE drive_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_drive_folders" ON drive_folders;
CREATE POLICY "read_drive_folders" ON drive_folders
  FOR SELECT USING (true);

-- Writes come from the Python indexer with the service_role key,
-- which bypasses RLS — no insert/update policy needed.
