-- Single-letter name segments (record_a_id) do not round-trip through camelCase mapping.
ALTER TABLE duplicate_cases RENAME COLUMN record_a_id TO first_record_id;
ALTER TABLE duplicate_cases RENAME COLUMN record_b_id TO second_record_id;
