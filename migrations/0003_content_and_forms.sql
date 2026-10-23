-- Website content (versioned, draft/published) and configurable intake/application forms.

-- ---------------------------------------------------------------------------------------------
-- Content. Pages, services, FAQs, resources and globals (navigation, site settings, footer)
-- share one versioning model: every save creates an immutable revision; publishing points the
-- entry at a revision; restoring copies an old revision into a new draft revision.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE content_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection text NOT NULL CHECK (collection IN ('page', 'service', 'faq', 'resource', 'global')),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:[-/][a-z0-9]+)*$' AND length(slug) <= 160),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  latest_revision_id uuid,
  published_revision_id uuid,
  published_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection, slug),
  CHECK (status <> 'published' OR published_revision_id IS NOT NULL)
);

CREATE TABLE content_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES content_entries (id),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  title text NOT NULL,
  data jsonb NOT NULL,
  seo jsonb NOT NULL DEFAULT '{}',
  change_note text,
  author_staff_id uuid REFERENCES staff_members (id),
  restored_from_revision_id uuid REFERENCES content_revisions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, revision_number),
  UNIQUE (entry_id, id)
);
CREATE TRIGGER content_revisions_immutable BEFORE UPDATE OR DELETE ON content_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- A published or latest revision must belong to the same entry.
ALTER TABLE content_entries
  ADD CONSTRAINT content_entries_latest_fk FOREIGN KEY (id, latest_revision_id) REFERENCES content_revisions (entry_id, id),
  ADD CONSTRAINT content_entries_published_fk FOREIGN KEY (id, published_revision_id) REFERENCES content_revisions (entry_id, id);

CREATE TABLE content_publish_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES content_entries (id),
  revision_id uuid REFERENCES content_revisions (id),
  action text NOT NULL CHECK (action IN ('published', 'unpublished', 'restored', 'archived', 'unarchived')),
  actor_staff_id uuid REFERENCES staff_members (id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_publish_events_entry_idx ON content_publish_events (entry_id, occurred_at DESC);
CREATE TRIGGER content_publish_events_immutable BEFORE UPDATE OR DELETE ON content_publish_events
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Licensed website imagery only. Applicant uploads never go here (see documents).
CREATE TABLE public_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL UNIQUE,
  public_url text,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4')),
  size_bytes integer CHECK (size_bytes > 0),
  width integer,
  height integer,
  alt_text text NOT NULL DEFAULT '',
  credit text,
  license text,
  source_url text,
  status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload', 'ready', 'archived')),
  uploaded_by uuid REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Forms. Question keys are permanent; labels can change. Publishing a form version embeds a
-- frozen copy of each question so later edits never alter what an applicant saw.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE question_definitions (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  scope text NOT NULL CHECK (scope IN ('family_enquiry', 'candidate_application')),
  answer_type text NOT NULL CHECK (answer_type IN (
    'short_text', 'long_text', 'number', 'yes_no', 'date', 'single_choice', 'multiple_choice', 'repeating_group'
  )),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  help_text text,
  options jsonb NOT NULL DEFAULT '[]',
  validation jsonb NOT NULL DEFAULT '{}',
  item_fields jsonb NOT NULL DEFAULT '[]',
  classification text NOT NULL DEFAULT 'standard' CHECK (classification IN ('standard', 'contact', 'sensitive')),
  filterable boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by uuid REFERENCES staff_members (id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT filterable OR answer_type IN ('short_text', 'number', 'yes_no', 'date', 'single_choice', 'multiple_choice')),
  CHECK (NOT filterable OR classification <> 'sensitive')
);

CREATE TABLE form_definitions (
  key text PRIMARY KEY CHECK (key IN ('family_enquiry', 'candidate_application')),
  name text NOT NULL,
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE form_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_key text NOT NULL REFERENCES form_definitions (key),
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  layout jsonb NOT NULL,
  notes text,
  created_by uuid REFERENCES staff_members (id),
  published_by uuid REFERENCES staff_members (id),
  published_at timestamptz,
  retired_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_key, version_number),
  UNIQUE (form_key, id),
  CHECK (status = 'draft' OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX form_versions_one_published_idx ON form_versions (form_key) WHERE status = 'published';

ALTER TABLE form_definitions
  ADD CONSTRAINT form_definitions_current_fk FOREIGN KEY (key, current_version_id) REFERENCES form_versions (form_key, id);

CREATE FUNCTION form_version_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Published form versions cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.layout IS DISTINCT FROM OLD.layout OR NEW.form_key IS DISTINCT FROM OLD.form_key
      OR NEW.version_number IS DISTINCT FROM OLD.version_number) THEN
    RAISE EXCEPTION 'A published form version is immutable; create a new version' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'A retired form version cannot be republished' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER form_versions_freeze BEFORE UPDATE OR DELETE ON form_versions FOR EACH ROW EXECUTE FUNCTION form_version_freeze();

SELECT attach_updated_at_triggers();
