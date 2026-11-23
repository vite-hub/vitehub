CREATE TABLE votes (id integer PRIMARY KEY, feedback_id integer NOT NULL);
CREATE INDEX votes_feedback_id ON votes (feedback_id);
