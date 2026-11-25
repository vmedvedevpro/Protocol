-- A line the user moved to a speaker on its own (Who said this, "These
-- lines"), not with the rest of its speaker. A rerun of Identify speakers
-- relabels every other line from the new voice clusters and keeps this one
-- (#217). Lines from before this migration carry no such mark: the data
-- cannot tell a line moved by hand from a speaker renamed as a whole.
ALTER TABLE transcripts ADD COLUMN speaker_manual INTEGER NOT NULL DEFAULT 0;
