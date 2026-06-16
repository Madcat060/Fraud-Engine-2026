-- =============================================================================
-- game_integrity — Primary_* performance schema (run manually after backup)
-- =============================================================================
-- Prerequisites: no dependent views blocking ALTER, or drop/recreate them first.
-- Invalid timestamps / IPs will cause ALTER to fail — clean data or fix USING.
--
-- Suggested: psql -v ON_ERROR_STOP=1 -f db_optimizations.sql
-- Avoid wrapping in a single transaction if you use CREATE INDEX CONCURRENTLY.
-- =============================================================================

-- --- Timestamps (native type removes per-query ::TIMESTAMP casts) ------------

ALTER TABLE "Primary_Login_activity_by_player"
  ALTER COLUMN "Login Date Time" TYPE TIMESTAMP
  USING (CASE WHEN TRIM(COALESCE("Login Date Time"::TEXT, '')) = '' THEN NULL ELSE TRIM("Login Date Time"::TEXT)::TIMESTAMP END);

-- Rule 17 (login anchor) duration math
ALTER TABLE "Primary_Login_activity_by_player"
  ALTER COLUMN "Logout Date Time" TYPE TIMESTAMP
  USING (CASE WHEN TRIM(COALESCE("Logout Date Time"::TEXT, '')) = '' THEN NULL ELSE TRIM("Logout Date Time"::TEXT)::TIMESTAMP END);

ALTER TABLE "Primary_Cash_table_session_summary"
  ALTER COLUMN "Session start date & time" TYPE TIMESTAMP
  USING (CASE WHEN TRIM(COALESCE("Session start date & time"::TEXT, '')) = '' THEN NULL ELSE TRIM("Session start date & time"::TEXT)::TIMESTAMP END);

ALTER TABLE "Primary_Cash_table_session_summary"
  ALTER COLUMN "Session end date & time" TYPE TIMESTAMP
  USING (CASE WHEN TRIM(COALESCE("Session end date & time"::TEXT, '')) = '' THEN NULL ELSE TRIM("Session end date & time"::TEXT)::TIMESTAMP END);

ALTER TABLE "Primary_Major_income_sessions"
  ALTER COLUMN "Start date" TYPE TIMESTAMP
  USING (CASE WHEN TRIM(COALESCE("Start date"::TEXT, '')) = '' THEN NULL ELSE TRIM("Start date"::TEXT)::TIMESTAMP END);

ALTER TABLE "Primary_Major_income_sessions"
  ALTER COLUMN "End date" TYPE TIMESTAMP
  USING (CASE WHEN TRIM(COALESCE("End date"::TEXT, '')) = '' THEN NULL ELSE TRIM("End date"::TEXT)::TIMESTAMP END);

-- Recommended for Rule 2 (burner) without ::TIMESTAMP on signup
ALTER TABLE "Primary_Account_information"
  ALTER COLUMN "Signup date + time" TYPE TIMESTAMP
  USING (CASE WHEN TRIM(COALESCE("Signup date + time"::TEXT, '')) = '' THEN NULL ELSE TRIM("Signup date + time"::TEXT)::TIMESTAMP END);

-- --- IP addresses (inet + index-friendly equality) -------------------------

ALTER TABLE "Primary_Cash_table_session_summary"
  ALTER COLUMN "Session ip" TYPE inet
  USING (CASE WHEN TRIM(COALESCE("Session ip"::TEXT, '')) = '' THEN NULL ELSE TRIM("Session ip"::TEXT)::inet END);

ALTER TABLE "Primary_Login_activity_by_player"
  ALTER COLUMN "IP" TYPE inet
  USING (CASE WHEN TRIM(COALESCE("IP"::TEXT, '')) = '' THEN NULL ELSE TRIM("IP"::TEXT)::inet END);

ALTER TABLE "Primary_Account_information"
  ALTER COLUMN "Signup IP" TYPE inet
  USING (CASE WHEN TRIM(COALESCE("Signup IP"::TEXT, '')) = '' THEN NULL ELSE TRIM("Signup IP"::TEXT)::inet END);

-- --- B-tree indexes: player keys + hot filter columns ------------------------

CREATE INDEX IF NOT EXISTS idx_primary_account_player_code
  ON "Primary_Account_information" ("Player Code");

CREATE INDEX IF NOT EXISTS idx_primary_cash_games_stats_player_code
  ON "Primary_Cash_Games_Player_Stats" ("Player code");

CREATE INDEX IF NOT EXISTS idx_primary_cash_session_player_code
  ON "Primary_Cash_table_session_summary" ("Player Code");

CREATE INDEX IF NOT EXISTS idx_primary_login_player_code
  ON "Primary_Login_activity_by_player" ("Player Code");

CREATE INDEX IF NOT EXISTS idx_primary_major_income_player_code
  ON "Primary_Major_income_sessions" ("Player code");

CREATE INDEX IF NOT EXISTS idx_primary_mtt_player_code
  ON "Primary_SNG_Twister_and_MTT" ("Player code");

CREATE INDEX IF NOT EXISTS idx_primary_login_login_time
  ON "Primary_Login_activity_by_player" ("Login Date Time");

CREATE INDEX IF NOT EXISTS idx_primary_login_ip
  ON "Primary_Login_activity_by_player" ("IP");

CREATE INDEX IF NOT EXISTS idx_primary_cash_session_start
  ON "Primary_Cash_table_session_summary" ("Session start date & time");

CREATE INDEX IF NOT EXISTS idx_primary_cash_session_ip
  ON "Primary_Cash_table_session_summary" ("Session ip");

CREATE INDEX IF NOT EXISTS idx_primary_major_start_date
  ON "Primary_Major_income_sessions" ("Start date");

CREATE INDEX IF NOT EXISTS idx_primary_account_signup_ip
  ON "Primary_Account_information" ("Signup IP");

-- Optional: ANALYZE after bulk load
-- ANALYZE "Primary_Account_information", "Primary_Cash_Games_Player_Stats",
--   "Primary_Cash_table_session_summary", "Primary_Login_activity_by_player",
--   "Primary_Major_income_sessions", "Primary_SNG_Twister_and_MTT";
