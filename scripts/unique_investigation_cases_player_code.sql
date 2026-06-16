-- Run once in pgAdmin / DBeaver to enforce one case per player in investigation_cases.
-- Removes duplicate player_code rows (keeps most recent by id) then adds unique constraint.

-- Remove any accidental duplicates by keeping only the most recent row per player_code
DELETE FROM investigation_cases
WHERE id NOT IN (
    SELECT MAX(id)
    FROM investigation_cases
    GROUP BY player_code
);

-- Apply the permanent lock: one row per player_code
ALTER TABLE investigation_cases ADD CONSTRAINT unique_player_code UNIQUE (player_code);
