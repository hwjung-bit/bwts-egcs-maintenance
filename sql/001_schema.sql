-- BWTS/EGCS Maintenance Management — Supabase Schema
-- Run this in Supabase SQL Editor

-- 1. Ships master (21 vessels)
CREATE TABLE ships (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  teu         TEXT DEFAULT '',
  bwts_maker  TEXT DEFAULT '',
  egcs_maker  TEXT DEFAULT '',
  wms         TEXT DEFAULT '',
  cems        TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 2. Mail log (1,434 records)
CREATE TABLE mail_log (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  date        DATE NOT NULL,
  system      TEXT NOT NULL,
  ship_code   TEXT,
  ship_name   TEXT,
  keyword     TEXT DEFAULT '',
  subject     TEXT NOT NULL,
  sender      TEXT NOT NULL,
  mail_link   TEXT DEFAULT '',
  attachments TEXT DEFAULT '',
  drive_links TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  status      TEXT DEFAULT '미확인',
  reply_count INTEGER DEFAULT 0,
  last_reply  DATE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_mail_log_thread ON mail_log(thread_id);
CREATE INDEX idx_mail_log_ship   ON mail_log(ship_code);
CREATE INDEX idx_mail_log_system ON mail_log(system);
CREATE INDEX idx_mail_log_date   ON mail_log(date DESC);
CREATE INDEX idx_mail_log_status ON mail_log(status);

-- 3. Repairs (242 records)
CREATE TABLE repairs (
  id            TEXT PRIMARY KEY,
  ship_code     TEXT NOT NULL,
  system        TEXT NOT NULL,
  date          DATE,
  equip         TEXT DEFAULT '',
  stage         TEXT DEFAULT '미확인',
  symptom       TEXT DEFAULT '',
  action        TEXT DEFAULT '',
  parts         TEXT DEFAULT '',
  cost          TEXT DEFAULT '',
  attachments   JSONB DEFAULT '[]',
  history       JSONB DEFAULT '[]',
  email_subject TEXT DEFAULT '',
  email_link    TEXT DEFAULT '',
  needs_review  BOOLEAN DEFAULT false,
  source_msg_id TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_repairs_ship   ON repairs(ship_code);
CREATE INDEX idx_repairs_system ON repairs(system);
CREATE INDEX idx_repairs_stage  ON repairs(stage);

-- 4. Calibrations (81 records: 21 BWTS + 60 EGCS)
CREATE TABLE calibrations (
  id              TEXT PRIMARY KEY,
  ship_code       TEXT NOT NULL,
  system          TEXT NOT NULL,
  equip           TEXT NOT NULL,
  last_date       DATE,
  interval_months INTEGER DEFAULT 12,
  note            TEXT DEFAULT '',
  serial          TEXT DEFAULT '',
  model           TEXT DEFAULT '',
  cert_url        TEXT DEFAULT '',
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_cal_ship   ON calibrations(ship_code);
CREATE INDEX idx_cal_system ON calibrations(system);

-- 5. Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mail_log_updated
  BEFORE UPDATE ON mail_log
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_repairs_updated
  BEFORE UPDATE ON repairs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_calibrations_updated
  BEFORE UPDATE ON calibrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
