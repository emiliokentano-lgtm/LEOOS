-- ===========================================================================
-- LEOOS — database-level invariants
--
-- These are the guarantees that must hold even if an application code path is
-- wrong (engineering rule: use database constraints where appropriate). A
-- constraint enforced only in TypeScript is a convention; enforced here it is an
-- invariant.
--
-- Covers docs/architecture/01-data-model.md §8 items 6, 7, 10, 12 and 16, plus
-- the two deliberately-deferred cross-context foreign keys.
-- ===========================================================================

-- ── Cross-context foreign keys ─────────────────────────────────────────────
-- Added here rather than in the schema modules because they would create import
-- cycles (person ↔ game_identity, incident ↔ criminal_charge). The constraint is
-- identical; only the declaration site differs.

ALTER TABLE "game_identity"
  ADD CONSTRAINT "game_identity_person_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "criminal_charge"
  ADD CONSTRAINT "criminal_charge_incident_id_fk"
  FOREIGN KEY ("incident_id") REFERENCES "incident"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "unit"
  ADD CONSTRAINT "unit_current_incident_id_fk"
  FOREIGN KEY ("current_incident_id") REFERENCES "incident"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "member_status_history"
  ADD CONSTRAINT "member_status_history_unit_id_fk"
  FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "position_history"
  ADD CONSTRAINT "position_history_unit_id_fk"
  FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "position_history"
  ADD CONSTRAINT "position_history_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "position_history" ADD PRIMARY KEY ("id", "recorded_at");
--> statement-breakpoint

-- ── Invariant 6: a member's roles belong to the member's organization ──────
--
-- Without this, a crafted request that slipped past validation could attach a PD
-- Chief role to an ICE membership, producing a rank the authorization kernel
-- would then honour. Global roles (organization_id IS NULL) are permitted.

CREATE OR REPLACE FUNCTION check_member_role_organization() RETURNS trigger
AS $$
DECLARE
  role_org uuid;
  member_org uuid;
BEGIN
  SELECT organization_id INTO role_org   FROM role                 WHERE id = NEW.role_id;
  SELECT organization_id INTO member_org FROM organization_member  WHERE id = NEW.member_id;

  IF role_org IS NOT NULL AND role_org <> member_org THEN
    RAISE EXCEPTION
      'cross-organization role assignment refused: role % belongs to organization %, member % belongs to %',
      NEW.role_id, role_org, NEW.member_id, member_org
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER member_role_organization_check
  BEFORE INSERT OR UPDATE ON "member_role"
  FOR EACH ROW EXECUTE FUNCTION check_member_role_organization();
--> statement-breakpoint

-- ── Invariant 7: global permissions never on organization-scoped roles ─────
--
-- This is what stops a PD Chief writing themselves an `admin.users` role. It is
-- the structural half of the defence; the authorization kernel is the other.

CREATE OR REPLACE FUNCTION check_role_permission_scope() RETURNS trigger
AS $$
DECLARE
  perm_scope permission_scope;
  role_org uuid;
BEGIN
  SELECT scope INTO perm_scope FROM permission WHERE key = NEW.permission_key;
  SELECT organization_id INTO role_org FROM role WHERE id = NEW.role_id;

  IF perm_scope = 'global' AND role_org IS NOT NULL THEN
    RAISE EXCEPTION
      'global-scope permission % cannot be attached to organization role %',
      NEW.permission_key, NEW.role_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER role_permission_scope_check
  BEFORE INSERT OR UPDATE ON "role_permission"
  FOR EACH ROW EXECUTE FUNCTION check_role_permission_scope();
--> statement-breakpoint

-- ── Invariant 12: an organization lead must be a member of that organization ──

CREATE OR REPLACE FUNCTION check_organization_lead_membership() RETURNS trigger
AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    RETURN NEW; -- revoking never needs an active membership
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM organization_member
    WHERE user_id = NEW.user_id
      AND organization_id = NEW.organization_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION
      'organization lead refused: user % has no active membership in organization %',
      NEW.user_id, NEW.organization_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER organization_lead_membership_check
  BEFORE INSERT OR UPDATE ON "organization_lead"
  FOR EACH ROW EXECUTE FUNCTION check_organization_lead_membership();
--> statement-breakpoint

-- ── Invariant 16: a role cannot be archived while it is still assigned ─────
--
-- Otherwise archiving a role silently leaves its holders without authority. The
-- API surfaces the blocking assignments so they can be reassigned first.

CREATE OR REPLACE FUNCTION check_role_archive_unassigned() RETURNS trigger
AS $$
DECLARE
  assigned_count int;
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    SELECT count(*) INTO assigned_count FROM member_role WHERE role_id = NEW.id;
    IF assigned_count > 0 THEN
      RAISE EXCEPTION
        'cannot archive role %: still assigned to % member(s)', NEW.id, assigned_count
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER role_archive_unassigned_check
  BEFORE UPDATE ON "role"
  FOR EACH ROW EXECUTE FUNCTION check_role_archive_unassigned();
--> statement-breakpoint

-- ── Invariant: an organization cannot be archived with active members ──────

CREATE OR REPLACE FUNCTION check_organization_archive_empty() RETURNS trigger
AS $$
DECLARE
  active_count int;
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    SELECT count(*) INTO active_count
      FROM organization_member
      WHERE organization_id = NEW.id AND status = 'active';
    IF active_count > 0 THEN
      RAISE EXCEPTION
        'cannot archive organization %: % active member(s) remain', NEW.id, active_count
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER organization_archive_empty_check
  BEFORE UPDATE ON "organization"
  FOR EACH ROW EXECUTE FUNCTION check_organization_archive_empty();
--> statement-breakpoint

-- ── updated_at triggers ────────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_account','organization','role','organization_member','person','vehicle',
    'incident','unit','statute','incident_type','operational_status','game_server',
    'medical_record','game_identity'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Search indexes ─────────────────────────────────────────────────────────
-- Trigram indexes for fuzzy name/plate lookup. Operators type partial and
-- misspelled names constantly; exact-prefix B-tree matching is not enough.

CREATE INDEX person_name_trgm_idx ON "person"
  USING gin ((first_name || ' ' || last_name) gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX person_alias_trgm_idx ON "person_alias" USING gin (alias gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX vehicle_plate_trgm_idx ON "vehicle" USING gin ((plate::text) gin_trgm_ops);
--> statement-breakpoint

CREATE INDEX incident_title_trgm_idx ON "incident" USING gin (title gin_trgm_ops);
--> statement-breakpoint

-- ── Append-only enforcement ────────────────────────────────────────────────
--
-- The audit log and the incident timeline are legal records. Making them
-- append-only by TRIGGER means tampering requires superuser access rather than
-- an application bug, and it holds regardless of which database role connects.

CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER incident_log_append_only
  BEFORE UPDATE OR DELETE ON "incident_log"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER member_status_history_append_only
  BEFORE UPDATE OR DELETE ON "member_status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

-- Belt and braces: the application role also lacks the privilege outright.
-- Created idempotently so a fresh database provisions without manual setup.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leoos_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log", "incident_log", "member_status_history"
      FROM leoos_app;
  END IF;
END $$;
