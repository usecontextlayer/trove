-- The unit is a trove (owner-ruled vocabulary, 2026-08-10: "they're troves!!").
-- Renaming the table keeps the code's ontology tight: one concept, one name.
ALTER TABLE artifact RENAME TO trove;
