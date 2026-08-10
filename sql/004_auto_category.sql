-- 004: Add body_preview and category columns for mail automation
-- Run in Supabase SQL Editor

-- 1. Body preview — first ~200 chars of email body
ALTER TABLE mail_log
  ADD COLUMN IF NOT EXISTS body_preview TEXT DEFAULT '';

-- 2. Auto-category — 수리요청/견적/검교정/SR/부품/정보
ALTER TABLE mail_log
  ADD COLUMN IF NOT EXISTS category TEXT DEFAULT '';

-- 3. Index for category filtering
CREATE INDEX IF NOT EXISTS idx_mail_log_category
  ON mail_log(category);
