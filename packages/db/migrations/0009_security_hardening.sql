-- ===========================================================================
-- LEOOS — Security hardening
-- ===========================================================================
--
-- Found by the security audit. Each block records what was reachable before it.

-- ── TRUNCATE erased the audit log ──────────────────────────────────────────
--
-- `audit_log`, `incident_log` and `member_status_history` are append-only,
-- enforced since 0001 by a trigger on UPDATE and DELETE. TRUNCATE fires NEITHER
-- of those: it is its own statement type with its own trigger event, so
--
--     TRUNCATE audit_log;
--
-- removed the entire legal record in one statement and the append-only guarantee
-- did nothing. The REVOKE below it was the only thing standing in the way, and
-- it is wrapped in a role check that silently does nothing when the application
-- connects as a role named anything other than `leoos_app` — which is exactly
-- the case in development, and is a deployment detail rather than a guarantee.
--
-- A trigger is the right layer because it holds regardless of which role
-- connects. Bypassing it now requires disabling the trigger, which requires
-- table ownership or superuser: a deliberate, auditable act at the database
-- level rather than one stray statement from the application.
--
-- FOR EACH STATEMENT is the only form TRUNCATE supports — there are no rows to
-- iterate — which is why this is a separate trigger rather than an extra event
-- on the existing one.

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER incident_log_no_truncate
  BEFORE TRUNCATE ON "incident_log"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

CREATE TRIGGER member_status_history_no_truncate
  BEFORE TRUNCATE ON "member_status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_mutation();
--> statement-breakpoint

COMMENT ON TRIGGER audit_log_no_truncate ON "audit_log" IS
  'TRUNCATE does not fire UPDATE/DELETE triggers. Without this the append-only '
  'guarantee could be erased by a single statement.';
