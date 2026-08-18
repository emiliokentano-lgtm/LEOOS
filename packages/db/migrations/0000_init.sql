-- ===========================================================================
-- LEOOS — migration prelude
--
-- Extensions and functions the generated schema depends on. Written at the head
-- of the first migration because every table below uses uuidv7() as its default
-- and several natural keys are citext.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

--> statement-breakpoint

-- UUID v7 — time-sortable, so B-tree inserts stay sequential instead of
-- scattering across the index the way v4 does. Postgres 18 has this built in;
-- on 16 we implement it.
--
-- Layout (RFC 9562 §5.7): 48-bit big-endian millisecond timestamp, 4-bit
-- version, 12-bit rand_a, 2-bit variant, 62-bit rand_b.
--
-- rand_a carries sub-millisecond precision (RFC 9562 §6.2 method 3) rather than
-- randomness, so ids generated inside the same millisecond still sort in
-- creation order. Without it, ordering is only guaranteed across milliseconds —
-- which is enough for index locality but makes "sorted by id" quietly wrong for
-- rows written in a burst, exactly what a dispatch system does.
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
AS $$
DECLARE
  now_us    bigint;   -- microseconds since the epoch
  ms        bigint;
  sub_ms    int;      -- 0..4095, the fractional millisecond
  uuid_bytes bytea;
BEGIN
  now_us := (extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  ms     := now_us / 1000;
  sub_ms := ((now_us % 1000) * 4096 / 1000)::int;

  -- 48-bit timestamp: drop the two high bytes of the 8-byte big-endian encoding.
  uuid_bytes := substring(int8send(ms) FROM 3) || gen_random_bytes(10);

  -- Byte 6: version 7 in the high nibble, top 4 bits of sub_ms in the low.
  uuid_bytes := set_byte(uuid_bytes, 6, 112 | (sub_ms >> 8));
  -- Byte 7: remaining 8 bits of sub_ms.
  uuid_bytes := set_byte(uuid_bytes, 7, sub_ms & 255);
  -- Byte 8: RFC 4122 variant (10) in the top two bits, 6 random bits kept.
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);

  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$ LANGUAGE plpgsql VOLATILE;

--> statement-breakpoint

-- Incident numbering — `YYYY-MM-NNNNNN`, read aloud over radio. A sequence
-- rather than count(*)+1, which races under concurrent call creation.
CREATE SEQUENCE IF NOT EXISTS incident_number_seq;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION next_incident_number() RETURNS text
AS $$
  SELECT to_char(now(), 'YYYY-MM') || '-' || lpad(nextval('incident_number_seq')::text, 6, '0');
$$ LANGUAGE sql VOLATILE;

--> statement-breakpoint

-- Keeps `updated_at` honest without every code path remembering to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TYPE "public"."account_status" AS ENUM('pending_verification', 'active', 'suspended', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'game_server', 'job');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'denied', 'error');--> statement-breakpoint
CREATE TYPE "public"."auth_token_purpose" AS ENUM('email_verification', 'password_reset', 'email_change');--> statement-breakpoint
CREATE TYPE "public"."charge_severity" AS ENUM('infraction', 'misdemeanor', 'felony');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('pending', 'convicted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."flag_severity" AS ENUM('info', 'caution', 'critical');--> statement-breakpoint
CREATE TYPE "public"."game_identity_provider" AS ENUM('license', 'license2', 'steam', 'discord', 'fivem', 'xbl', 'live');--> statement-breakpoint
CREATE TYPE "public"."global_capability" AS ENUM('global_admin', 'user_admin', 'org_admin', 'audit_viewer', 'support');--> statement-breakpoint
CREATE TYPE "public"."incident_link_entity" AS ENUM('person', 'vehicle');--> statement-breakpoint
CREATE TYPE "public"."incident_link_relation" AS ENUM('suspect', 'victim', 'witness', 'involved', 'patient', 'reporting_party');--> statement-breakpoint
CREATE TYPE "public"."incident_log_entry_type" AS ENUM('note', 'status_change', 'assignment', 'arrival', 'clear', 'attachment', 'system');--> statement-breakpoint
CREATE TYPE "public"."incident_source" AS ENUM('manual', 'fivem', 'panic', 'automatic');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('pending', 'dispatched', 'on_scene', 'on_hold', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."license_status" AS ENUM('valid', 'suspended', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."license_type" AS ENUM('driver', 'weapon', 'pilot', 'boat', 'medical', 'business', 'hunting');--> statement-breakpoint
CREATE TYPE "public"."map_marker_type" AS ENUM('hazard', 'roadblock', 'staging', 'command_post', 'poi', 'custom');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'on_leave', 'suspended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'email', 'push');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."organization_category" AS ENUM('law_enforcement', 'medical', 'federal', 'military', 'civil_service', 'other');--> statement-breakpoint
CREATE TYPE "public"."permission_override_effect" AS ENUM('grant', 'deny');--> statement-breakpoint
CREATE TYPE "public"."permission_risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."permission_scope" AS ENUM('organization', 'global');--> statement-breakpoint
CREATE TYPE "public"."person_status" AS ENUM('alive', 'deceased', 'missing', 'incarcerated');--> statement-breakpoint
CREATE TYPE "public"."session_revoke_reason" AS ENUM('logout', 'admin', 'password_change', 'privilege_change', 'expired');--> statement-breakpoint
CREATE TYPE "public"."unit_status" AS ENUM('active', 'disbanded');--> statement-breakpoint
CREATE TYPE "public"."vehicle_insurance_status" AS ENUM('insured', 'uninsured', 'expired');--> statement-breakpoint
CREATE TYPE "public"."vehicle_registration_status" AS ENUM('registered', 'expired', 'unregistered');--> statement-breakpoint
CREATE TYPE "public"."warrant_status" AS ENUM('active', 'served', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."warrant_type" AS ENUM('arrest', 'search', 'bench');--> statement-breakpoint
CREATE TABLE "auth_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"new_email" "citext",
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_token_new_email_only_for_change" CHECK ("auth_token"."purpose" = 'email_change' OR "auth_token"."new_email" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "game_identity" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" "game_identity_provider" NOT NULL,
	"identifier" text NOT NULL,
	"user_id" uuid,
	"person_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_identity_requires_subject" CHECK ("game_identity"."user_id" IS NOT NULL OR "game_identity"."person_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "identity_claim_code" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"code" "citext" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_identity" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "session_revoke_reason"
);
--> statement-breakpoint
CREATE TABLE "user_account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" "citext" NOT NULL,
	"username" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "account_status" DEFAULT 'pending_verification' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"totp_secret_enc" text,
	"totp_enabled_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_login_ip" "inet",
	"permission_version" integer DEFAULT 1 NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_account_active_requires_verification" CHECK ("user_account"."status" <> 'active' OR "user_account"."email_verified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "user_global_role" (
	"user_id" uuid NOT NULL,
	"capability" "global_capability" NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_global_role_user_id_capability_pk" PRIMARY KEY("user_id","capability")
);
--> statement-breakpoint
CREATE TABLE "member_permission_override" (
	"member_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"effect" "permission_override_effect" NOT NULL,
	"reason" text NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "member_permission_override_member_id_permission_key_pk" PRIMARY KEY("member_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "member_role" (
	"member_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_role_member_id_role_id_pk" PRIMARY KEY("member_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" "citext" NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"description" text,
	"category" "organization_category" DEFAULT 'other' NOT NULL,
	"color" text DEFAULT '#6b7686' NOT NULL,
	"logo_url" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"deletion_reason" text,
	CONSTRAINT "organization_soft_delete_complete" CHECK (("organization"."deleted_at" IS NULL) = ("organization"."deleted_by" IS NULL)
          AND ("organization"."deleted_at" IS NOT NULL OR "organization"."deletion_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "organization_lead" (
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "organization_lead_user_id_organization_id_pk" PRIMARY KEY("user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "organization_member" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"person_id" uuid,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"callsign" "citext",
	"employee_number" "citext",
	"notes" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hired_by" uuid,
	"left_at" timestamp with time zone,
	"terminated_by" uuid,
	"termination_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_member_termination_complete" CHECK ("organization_member"."status" <> 'terminated' OR "organization_member"."left_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "permission" (
	"key" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"scope" "permission_scope" DEFAULT 'organization' NOT NULL,
	"risk" "permission_risk" DEFAULT 'low' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid,
	"key" "citext" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"hierarchy_level" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"color" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"deletion_reason" text,
	CONSTRAINT "role_hierarchy_range" CHECK ("role"."hierarchy_level" BETWEEN 1 AND 100),
	CONSTRAINT "role_soft_delete_complete" CHECK (("role"."deleted_at" IS NULL) = ("role"."deleted_by" IS NULL)
          AND ("role"."deleted_at" IS NOT NULL OR "role"."deletion_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permission_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "criminal_charge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"incident_id" uuid,
	"statute_code" text,
	"title" text NOT NULL,
	"severity" charge_severity NOT NULL,
	"status" charge_status DEFAULT 'pending' NOT NULL,
	"fine_amount" integer,
	"jail_time_minutes" integer,
	"points" integer,
	"notes" text,
	"filed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"type" "license_type" NOT NULL,
	"status" "license_status" DEFAULT 'valid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"issued_by" uuid,
	"suspended_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medical_record" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"blood_type" text,
	"allergies" text[],
	"conditions" text[],
	"medications" text[],
	"emergency_contact" text,
	"notes" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"date_of_birth" date,
	"gender" text,
	"phone_number" text,
	"address" text,
	"image_url" text,
	"height_cm" integer,
	"weight_kg" integer,
	"eye_color" text,
	"hair_color" text,
	"notes" text,
	"status" "person_status" DEFAULT 'alive' NOT NULL,
	"is_deceased" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"deletion_reason" text,
	CONSTRAINT "person_soft_delete_complete" CHECK (("person"."deleted_at" IS NULL) = ("person"."deleted_by" IS NULL)
          AND ("person"."deleted_at" IS NOT NULL OR "person"."deletion_reason" IS NULL)),
	CONSTRAINT "person_deceased_consistent" CHECK ("person"."is_deceased" = ("person"."status" = 'deceased'))
);
--> statement-breakpoint
CREATE TABLE "person_alias" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_flag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" "flag_severity" DEFAULT 'info' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "statute" (
	"code" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"severity" charge_severity NOT NULL,
	"default_fine" integer,
	"default_jail_minutes" integer,
	"category" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warrant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" "warrant_type" NOT NULL,
	"status" "warrant_status" DEFAULT 'active' NOT NULL,
	"reason" text NOT NULL,
	"issued_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"served_by" uuid,
	"served_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"plate" "citext" NOT NULL,
	"model" text NOT NULL,
	"display_name" text,
	"color" text,
	"vehicle_class" text,
	"owner_person_id" uuid,
	"owner_organization_id" uuid,
	"registration_status" "vehicle_registration_status" DEFAULT 'registered' NOT NULL,
	"insurance_status" "vehicle_insurance_status" DEFAULT 'uninsured' NOT NULL,
	"is_fleet" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"deletion_reason" text,
	CONSTRAINT "vehicle_single_owner" CHECK (NOT ("vehicle"."owner_person_id" IS NOT NULL AND "vehicle"."owner_organization_id" IS NOT NULL)),
	CONSTRAINT "vehicle_fleet_has_org" CHECK (NOT "vehicle"."is_fleet" OR "vehicle"."owner_organization_id" IS NOT NULL),
	CONSTRAINT "vehicle_soft_delete_complete" CHECK (("vehicle"."deleted_at" IS NULL) = ("vehicle"."deleted_by" IS NULL)
          AND ("vehicle"."deleted_at" IS NOT NULL OR "vehicle"."deletion_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "vehicle_flag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"type" text NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "incident" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"number" "citext" DEFAULT next_incident_number() NOT NULL,
	"organization_id" uuid,
	"type_key" text,
	"priority" integer DEFAULT 3 NOT NULL,
	"status" "incident_status" DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location_text" text,
	"pos_x" double precision,
	"pos_y" double precision,
	"pos_z" double precision,
	"caller_person_id" uuid,
	"caller_phone" text,
	"source" "incident_source" DEFAULT 'manual' NOT NULL,
	"created_by" uuid,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"closing_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"deletion_reason" text,
	CONSTRAINT "incident_priority_range" CHECK ("incident"."priority" BETWEEN 1 AND 5),
	CONSTRAINT "incident_closure_complete" CHECK ("incident"."status" <> 'closed' OR "incident"."closed_at" IS NOT NULL),
	CONSTRAINT "incident_soft_delete_complete" CHECK (("incident"."deleted_at" IS NULL) = ("incident"."deleted_by" IS NULL)
          AND ("incident"."deleted_at" IS NOT NULL OR "incident"."deletion_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "incident_assignment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"incident_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"role" text,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "incident_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"incident_id" uuid NOT NULL,
	"entity_type" "incident_link_entity" NOT NULL,
	"entity_id" uuid NOT NULL,
	"relation" "incident_link_relation" DEFAULT 'involved' NOT NULL,
	"note" text,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"incident_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text,
	"entry_type" "incident_log_entry_type" DEFAULT 'note' NOT NULL,
	"body" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_type" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"category" text,
	"default_priority" integer DEFAULT 3 NOT NULL,
	"color" text,
	"icon" text,
	"organization_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_type_priority_range" CHECK ("incident_type"."default_priority" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "map_marker" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid,
	"type" "map_marker_type" DEFAULT 'poi' NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"pos_x" double precision NOT NULL,
	"pos_y" double precision NOT NULL,
	"pos_z" double precision,
	"color" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"deletion_reason" text
);
--> statement-breakpoint
CREATE TABLE "member_status" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"status_key" text NOT NULL,
	"unit_id" uuid,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_status_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"member_id" uuid NOT NULL,
	"from_status_key" text,
	"to_status_key" text NOT NULL,
	"unit_id" uuid,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_status" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"short_label" text NOT NULL,
	"color_token" text NOT NULL,
	"icon" text NOT NULL,
	"is_available" boolean DEFAULT false NOT NULL,
	"is_on_duty" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"organization_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panic_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"member_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"unit_id" uuid,
	"incident_id" uuid,
	"pos_x" double precision,
	"pos_y" double precision,
	"pos_z" double precision,
	"source" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "position_history" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"unit_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"pos_x" double precision NOT NULL,
	"pos_y" double precision NOT NULL,
	"pos_z" double precision,
	"heading" double precision,
	"speed" double precision,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"callsign" "citext" NOT NULL,
	"name" text,
	"status" "unit_status" DEFAULT 'active' NOT NULL,
	"unit_type" text DEFAULT 'patrol' NOT NULL,
	"status_key" text DEFAULT 'available' NOT NULL,
	"vehicle_id" uuid,
	"pos_x" double precision,
	"pos_y" double precision,
	"pos_z" double precision,
	"heading" double precision,
	"position_updated_at" timestamp with time zone,
	"current_incident_id" uuid,
	"created_by" uuid,
	"disbanded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_disband_complete" CHECK ("unit"."status" <> 'disbanded' OR "unit"."disbanded_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "unit_member" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"unit_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"is_leader" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "game_server" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" "citext" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_server_credential" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"game_server_id" uuid NOT NULL,
	"key_id" "citext" NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
CREATE TABLE "game_server_state" (
	"game_server_id" uuid PRIMARY KEY NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"player_count" integer DEFAULT 0 NOT NULL,
	"resource_version" text,
	"last_ingest_seq" bigint DEFAULT 0 NOT NULL,
	"anomaly_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"outcome" "audit_outcome" DEFAULT 'success' NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"organization_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"channel" "notification_channel" DEFAULT 'in_app' NOT NULL,
	"severity" "notification_severity" DEFAULT 'info' NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"entity_type" text,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_identity" ADD CONSTRAINT "game_identity_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_claim_code" ADD CONSTRAINT "identity_claim_code_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_global_role" ADD CONSTRAINT "user_global_role_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_global_role" ADD CONSTRAINT "user_global_role_granted_by_user_account_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_permission_override" ADD CONSTRAINT "member_permission_override_member_id_organization_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."organization_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_permission_override" ADD CONSTRAINT "member_permission_override_permission_key_permission_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permission"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_permission_override" ADD CONSTRAINT "member_permission_override_granted_by_user_account_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_member_id_organization_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."organization_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_assigned_by_user_account_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_lead" ADD CONSTRAINT "organization_lead_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_lead" ADD CONSTRAINT "organization_lead_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_lead" ADD CONSTRAINT "organization_lead_granted_by_user_account_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_lead" ADD CONSTRAINT "organization_lead_revoked_by_user_account_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_hired_by_user_account_id_fk" FOREIGN KEY ("hired_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_terminated_by_user_account_id_fk" FOREIGN KEY ("terminated_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_key_permission_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permission"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_granted_by_user_account_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criminal_charge" ADD CONSTRAINT "criminal_charge_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criminal_charge" ADD CONSTRAINT "criminal_charge_statute_code_statute_code_fk" FOREIGN KEY ("statute_code") REFERENCES "public"."statute"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criminal_charge" ADD CONSTRAINT "criminal_charge_filed_by_user_account_id_fk" FOREIGN KEY ("filed_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_issued_by_user_account_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_record" ADD CONSTRAINT "medical_record_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_record" ADD CONSTRAINT "medical_record_updated_by_user_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_updated_by_user_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_alias" ADD CONSTRAINT "person_alias_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_alias" ADD CONSTRAINT "person_alias_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_flag" ADD CONSTRAINT "person_flag_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_flag" ADD CONSTRAINT "person_flag_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_flag" ADD CONSTRAINT "person_flag_resolved_by_user_account_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warrant" ADD CONSTRAINT "warrant_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warrant" ADD CONSTRAINT "warrant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warrant" ADD CONSTRAINT "warrant_issued_by_user_account_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warrant" ADD CONSTRAINT "warrant_served_by_user_account_id_fk" FOREIGN KEY ("served_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_owner_person_id_person_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_owner_organization_id_organization_id_fk" FOREIGN KEY ("owner_organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_flag" ADD CONSTRAINT "vehicle_flag_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicle"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_flag" ADD CONSTRAINT "vehicle_flag_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_flag" ADD CONSTRAINT "vehicle_flag_resolved_by_user_account_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_type_key_incident_type_key_fk" FOREIGN KEY ("type_key") REFERENCES "public"."incident_type"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_caller_person_id_person_id_fk" FOREIGN KEY ("caller_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_closed_by_user_account_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_assignment" ADD CONSTRAINT "incident_assignment_incident_id_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_assignment" ADD CONSTRAINT "incident_assignment_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_assignment" ADD CONSTRAINT "incident_assignment_assigned_by_user_account_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_link" ADD CONSTRAINT "incident_link_incident_id_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_link" ADD CONSTRAINT "incident_link_added_by_user_account_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_log" ADD CONSTRAINT "incident_log_incident_id_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_log" ADD CONSTRAINT "incident_log_actor_user_id_user_account_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_type" ADD CONSTRAINT "incident_type_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_marker" ADD CONSTRAINT "map_marker_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_marker" ADD CONSTRAINT "map_marker_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_status" ADD CONSTRAINT "member_status_member_id_organization_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."organization_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_status" ADD CONSTRAINT "member_status_status_key_operational_status_key_fk" FOREIGN KEY ("status_key") REFERENCES "public"."operational_status"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_status" ADD CONSTRAINT "member_status_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_status_history" ADD CONSTRAINT "member_status_history_member_id_organization_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_status_history" ADD CONSTRAINT "member_status_history_changed_by_user_account_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_status" ADD CONSTRAINT "operational_status_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panic_event" ADD CONSTRAINT "panic_event_member_id_organization_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panic_event" ADD CONSTRAINT "panic_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panic_event" ADD CONSTRAINT "panic_event_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panic_event" ADD CONSTRAINT "panic_event_incident_id_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incident"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panic_event" ADD CONSTRAINT "panic_event_acknowledged_by_user_account_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_status_key_operational_status_key_fk" FOREIGN KEY ("status_key") REFERENCES "public"."operational_status"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicle"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_member" ADD CONSTRAINT "unit_member_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_member" ADD CONSTRAINT "unit_member_member_id_organization_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_server_credential" ADD CONSTRAINT "game_server_credential_game_server_id_game_server_id_fk" FOREIGN KEY ("game_server_id") REFERENCES "public"."game_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_server_credential" ADD CONSTRAINT "game_server_credential_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_server_credential" ADD CONSTRAINT "game_server_credential_revoked_by_user_account_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_server_state" ADD CONSTRAINT "game_server_state_game_server_id_game_server_id_fk" FOREIGN KEY ("game_server_id") REFERENCES "public"."game_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_token_hash_key" ON "auth_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_token_user_purpose_idx" ON "auth_token" USING btree ("user_id","purpose") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "game_identity_provider_identifier_key" ON "game_identity" USING btree ("provider","identifier");--> statement-breakpoint
CREATE INDEX "game_identity_user_idx" ON "game_identity" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "game_identity_person_idx" ON "game_identity" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_claim_code_key" ON "identity_claim_code" USING btree ("code");--> statement-breakpoint
CREATE INDEX "identity_claim_user_idx" ON "identity_claim_code" USING btree ("user_id") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_hash_key" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_user_live_idx" ON "session" USING btree ("user_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" USING btree ("expires_at") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_account_email_key" ON "user_account" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "user_account_username_key" ON "user_account" USING btree ("username");--> statement-breakpoint
CREATE INDEX "user_account_status_idx" ON "user_account" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_global_role_capability_idx" ON "user_global_role" USING btree ("capability");--> statement-breakpoint
CREATE INDEX "member_permission_override_expiry_idx" ON "member_permission_override" USING btree ("expires_at") WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "member_role_role_idx" ON "member_role" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_key_key" ON "organization" USING btree ("key") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "organization_active_idx" ON "organization" USING btree ("is_active") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "organization_category_idx" ON "organization" USING btree ("category");--> statement-breakpoint
CREATE INDEX "organization_lead_org_idx" ON "organization_lead" USING btree ("organization_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_member_user_org_key" ON "organization_member" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_member_active_callsign_key" ON "organization_member" USING btree ("organization_id","callsign") WHERE status = 'active' AND callsign IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_member_active_employee_no_key" ON "organization_member" USING btree ("organization_id","employee_number") WHERE status = 'active' AND employee_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "organization_member_org_status_idx" ON "organization_member" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "organization_member_user_idx" ON "organization_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organization_member_person_idx" ON "organization_member" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "organization_member_active_idx" ON "organization_member" USING btree ("organization_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "permission_category_idx" ON "permission" USING btree ("category");--> statement-breakpoint
CREATE INDEX "permission_scope_idx" ON "permission" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "role_org_key_key" ON "role" USING btree ("organization_id","key") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "role_org_level_idx" ON "role" USING btree ("organization_id","hierarchy_level");--> statement-breakpoint
CREATE UNIQUE INDEX "role_one_default_per_org" ON "role" USING btree ("organization_id") WHERE is_default AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "role_permission_permission_idx" ON "role_permission" USING btree ("permission_key");--> statement-breakpoint
CREATE INDEX "criminal_charge_person_idx" ON "criminal_charge" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "criminal_charge_incident_idx" ON "criminal_charge" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "criminal_charge_status_idx" ON "criminal_charge" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "license_person_type_key" ON "license" USING btree ("person_id","type");--> statement-breakpoint
CREATE INDEX "license_status_idx" ON "license" USING btree ("status");--> statement-breakpoint
CREATE INDEX "person_last_first_idx" ON "person" USING btree ("last_name","first_name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "person_phone_idx" ON "person" USING btree ("phone_number") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "person_dob_idx" ON "person" USING btree ("date_of_birth");--> statement-breakpoint
CREATE INDEX "person_status_idx" ON "person" USING btree ("status") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "person_alias_key" ON "person_alias" USING btree ("person_id","alias");--> statement-breakpoint
CREATE INDEX "person_alias_search_idx" ON "person_alias" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "person_flag_active_idx" ON "person_flag" USING btree ("person_id") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "person_flag_severity_idx" ON "person_flag" USING btree ("severity") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "statute_category_idx" ON "statute" USING btree ("category");--> statement-breakpoint
CREATE INDEX "warrant_person_active_idx" ON "warrant" USING btree ("person_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "warrant_org_status_idx" ON "warrant" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "warrant_issued_at_idx" ON "warrant" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_plate_key" ON "vehicle" USING btree ("plate") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "vehicle_owner_person_idx" ON "vehicle" USING btree ("owner_person_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "vehicle_owner_org_idx" ON "vehicle" USING btree ("owner_organization_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "vehicle_model_idx" ON "vehicle" USING btree ("model");--> statement-breakpoint
CREATE INDEX "vehicle_flag_active_idx" ON "vehicle_flag" USING btree ("vehicle_id") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_number_key" ON "incident" USING btree ("number");--> statement-breakpoint
CREATE INDEX "incident_open_queue_idx" ON "incident" USING btree ("priority","created_at") WHERE status NOT IN ('closed', 'cancelled') AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "incident_org_status_idx" ON "incident" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "incident_status_idx" ON "incident" USING btree ("status");--> statement-breakpoint
CREATE INDEX "incident_created_at_idx" ON "incident" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "incident_type_idx" ON "incident" USING btree ("type_key");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_assignment_active_key" ON "incident_assignment" USING btree ("incident_id","unit_id") WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX "incident_assignment_unit_active_idx" ON "incident_assignment" USING btree ("unit_id") WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX "incident_assignment_incident_idx" ON "incident_assignment" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_link_key" ON "incident_link" USING btree ("incident_id","entity_type","entity_id","relation");--> statement-breakpoint
CREATE INDEX "incident_link_entity_idx" ON "incident_link" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "incident_log_incident_time_idx" ON "incident_log" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "incident_type_org_idx" ON "incident_type" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "map_marker_org_idx" ON "map_marker" USING btree ("organization_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "map_marker_expiry_idx" ON "map_marker" USING btree ("expires_at") WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "member_status_key_idx" ON "member_status" USING btree ("status_key");--> statement-breakpoint
CREATE INDEX "member_status_unit_idx" ON "member_status" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "member_status_history_member_time_idx" ON "member_status_history" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "member_status_history_time_idx" ON "member_status_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "operational_status_org_idx" ON "operational_status" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "panic_event_unresolved_idx" ON "panic_event" USING btree ("organization_id") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "panic_event_created_idx" ON "panic_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "position_history_unit_time_idx" ON "position_history" USING btree ("unit_id","recorded_at");--> statement-breakpoint
CREATE INDEX "position_history_org_time_idx" ON "position_history" USING btree ("organization_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "unit_active_callsign_key" ON "unit" USING btree ("organization_id","callsign") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "unit_org_status_idx" ON "unit" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "unit_status_key_idx" ON "unit" USING btree ("status_key") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "unit_incident_idx" ON "unit" USING btree ("current_incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unit_member_one_active_per_member" ON "unit_member" USING btree ("member_id") WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX "unit_member_unit_idx" ON "unit_member" USING btree ("unit_id") WHERE left_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "unit_member_one_leader" ON "unit_member" USING btree ("unit_id") WHERE is_leader AND left_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "game_server_key_key" ON "game_server" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "game_server_credential_key_id_key" ON "game_server_credential" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "game_server_credential_live_idx" ON "game_server_credential" USING btree ("game_server_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "audit_log_occurred_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_idx" ON "audit_log" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_denied_idx" ON "audit_log" USING btree ("occurred_at") WHERE outcome = 'denied';--> statement-breakpoint
CREATE INDEX "notification_user_unread_idx" ON "notification" USING btree ("user_id","created_at") WHERE read_at IS NULL;--> statement-breakpoint
CREATE INDEX "notification_user_time_idx" ON "notification" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_entity_idx" ON "notification" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "notification_org_idx" ON "notification" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_status_history_unit_idx" ON "member_status_history" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "notification_undispatched_idx" ON "notification" USING btree ("created_at") WHERE dispatched_at IS NULL;