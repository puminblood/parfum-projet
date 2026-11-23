CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  organization TEXT,
  role TEXT NOT NULL DEFAULT 'parfumeur',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'a_classer';
ALTER TABLE participants ALTER COLUMN role SET DEFAULT 'parfumeur';
DROP INDEX IF EXISTS participants_name_ci;
CREATE UNIQUE INDEX IF NOT EXISTS participants_name_role_ci
  ON participants (lower(name), role);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'participants_role_valid' AND conrelid = 'participants'::regclass) THEN
    ALTER TABLE participants ADD CONSTRAINT participants_role_valid
      CHECK (role IN ('commercial', 'assistant_commercial', 'parfumeur', 'a_classer'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS product_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_references_label_ci
  ON product_references (lower(label));

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'selection',
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'finished')),
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'won', 'lost')),
  deadline DATE,
  rmc_amount NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS rmc_amount NUMERIC(12,2);
ALTER TABLE projects ALTER COLUMN stage SET DEFAULT 'selection';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_rmc_amount_nonnegative') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_rmc_amount_nonnegative
      CHECK (rmc_amount IS NULL OR rmc_amount >= 0);
  END IF;
END $$;

UPDATE projects SET stage = CASE stage
  WHEN 'briefing' THEN 'selection'
  WHEN 'exploration' THEN 'lab_availability'
  WHEN 'evaluation' THEN 'sample_evaluation'
  WHEN 'validation' THEN 'commercial_review'
  WHEN 'finalisation' THEN 'client_sample'
  ELSE stage
END
WHERE stage IN ('briefing', 'exploration', 'evaluation', 'validation', 'finalisation');

CREATE TABLE IF NOT EXISTS project_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL CHECK (step_key IN ('selection', 'lab_availability', 'sample_weighing', 'reweigh', 'sample_evaluation', 'commercial_review', 'client_sample')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'not_applicable')),
  step_order SMALLINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, step_key)
);
CREATE INDEX IF NOT EXISTS project_steps_project_order ON project_steps(project_id, step_order);

WITH step_catalog(step_key, step_order) AS (VALUES
  ('selection', 1), ('lab_availability', 2), ('sample_weighing', 3),
  ('reweigh', 4), ('sample_evaluation', 5), ('commercial_review', 6), ('client_sample', 7)
), project_progress AS (
  SELECT p.id, p.stage,
    CASE p.stage
      WHEN 'selection' THEN 1 WHEN 'lab_availability' THEN 2
      WHEN 'sample_weighing' THEN 3 WHEN 'reweigh' THEN 4
      WHEN 'sample_evaluation' THEN 5 WHEN 'commercial_review' THEN 6
      WHEN 'client_sample' THEN 7 ELSE 1
    END AS active_position
  FROM projects p
)
INSERT INTO project_steps(project_id, step_key, status, step_order)
SELECT pp.id, sc.step_key,
  CASE WHEN sc.step_order < pp.active_position THEN 'done'
       WHEN sc.step_order = pp.active_position THEN 'in_progress'
       ELSE 'pending' END,
  sc.step_order
FROM project_progress pp CROSS JOIN step_catalog sc
ON CONFLICT (project_id, step_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS project_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
  UNIQUE (project_id, participant_id)
);

CREATE TABLE IF NOT EXISTS project_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reference_id UUID NOT NULL REFERENCES product_references(id) ON DELETE RESTRICT,
  UNIQUE (project_id, reference_id)
);

CREATE TABLE IF NOT EXISTS project_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  show_on_dashboard BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_notes_project_created
  ON project_notes (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS projects_status_deadline
  ON projects (status, deadline);
