-- Browser-verification fixtures.
--
-- NOT production data and never loaded into one: every account is a `ui.*`
-- username on @test.invalid, and the password hash is cloned from an account the
-- test suite created, so the shared password is the suite's own
-- 'correct-horse-staple-42'. Cloning rather than registering through the API
-- avoids fighting the registration rate limiter, which is doing its job.
--
-- Idempotent — safe to re-run after the database test suite drops the schema.

WITH src AS (
  SELECT password_hash FROM user_account
  WHERE status = 'active' AND email LIKE '%@test.invalid'
  ORDER BY created_at DESC LIMIT 1
), names(username, display) AS (VALUES
  ('ui.admin','Ada Sysadmin'), ('ui.chief','Marcus Vale'), ('ui.commander','Renata Ochoa'),
  ('ui.lieutenant','Dev Okonkwo'), ('ui.sergeant','Priya Raman'),
  ('ui.officer1','Tomas Brandt'), ('ui.officer2','Ingrid Solberg'), ('ui.officer3','Kwame Asante'),
  ('ui.cadet1','Lena Fischer'), ('ui.cadet2','Yusuf Demir'),
  ('ui.recruit1','Nora Lindqvist'), ('ui.recruit2','Hiro Tanaka'), ('ui.medic','Sofia Marchetti')
)
INSERT INTO user_account (email, username, display_name, password_hash, status, email_verified_at)
SELECT n.username || '@test.invalid', n.username, n.display, src.password_hash, 'active', now()
FROM names n CROSS JOIN src
ON CONFLICT (username) DO UPDATE
SET display_name = excluded.display_name, password_hash = excluded.password_hash,
    status = 'active', email_verified_at = now(),
    failed_login_count = 0, locked_until = NULL;

INSERT INTO user_global_role (user_id, capability)
SELECT id, 'global_admin' FROM user_account WHERE username = 'ui.admin'
ON CONFLICT DO NOTHING;

WITH pd AS (SELECT id FROM organization WHERE key = 'PD'),
seedset(username, rolekey, callsign, empno) AS (VALUES
  ('ui.chief','chief','1-COMMAND-1','1001'),
  ('ui.commander','commander','1-COMMAND-4','1004'),
  ('ui.lieutenant','lieutenant','1-LINCOLN-10','1102'),
  ('ui.sergeant','sergeant','1-SAM-20','1205'),
  ('ui.officer1','officer','1-ADAM-12','1411'),
  ('ui.officer2','officer','1-ADAM-15','1422'),
  ('ui.officer3','officer','2-BOY-7','1433'),
  ('ui.cadet1','cadet','1-TOM-3','1590'),
  ('ui.cadet2','cadet','1-TOM-4','1591'),
  ('ui.recruit1','cadet',NULL,'1600'),
  ('ui.recruit2','cadet',NULL,'1601')
)
INSERT INTO organization_member (user_id, organization_id, callsign, employee_number, status, hired_by)
SELECT u.id, pd.id, s.callsign, s.empno, 'active',
       (SELECT id FROM user_account WHERE username = 'ui.chief')
FROM seedset s JOIN user_account u ON u.username = s.username CROSS JOIN pd
ON CONFLICT (user_id, organization_id) DO UPDATE SET status = 'active';

WITH pd AS (SELECT id FROM organization WHERE key = 'PD'),
seedset(username, rolekey) AS (VALUES
  ('ui.chief','chief'), ('ui.commander','commander'), ('ui.lieutenant','lieutenant'),
  ('ui.sergeant','sergeant'), ('ui.officer1','officer'), ('ui.officer2','officer'),
  ('ui.officer3','officer'), ('ui.cadet1','cadet'), ('ui.cadet2','cadet'),
  ('ui.recruit1','cadet'), ('ui.recruit2','cadet')
)
INSERT INTO member_role (member_id, role_id)
SELECT m.id, r.id FROM seedset s
JOIN user_account u ON u.username = s.username CROSS JOIN pd
JOIN organization_member m ON m.user_id = u.id AND m.organization_id = pd.id
JOIN role r ON r.organization_id = pd.id AND r.key = s.rolekey
ON CONFLICT DO NOTHING;

INSERT INTO organization_member (user_id, organization_id, callsign, employee_number, status)
SELECT u.id, o.id, 'MD-3', '3001', 'active' FROM user_account u, organization o
WHERE u.username = 'ui.medic' AND o.key = 'MD'
ON CONFLICT (user_id, organization_id) DO UPDATE SET status = 'active';

INSERT INTO member_role (member_id, role_id)
SELECT m.id, r.id FROM organization_member m
JOIN user_account u ON u.id = m.user_id
JOIN organization o ON o.id = m.organization_id
JOIN role r ON r.organization_id = o.id AND r.key = 'doctor'
WHERE u.username = 'ui.medic' AND o.key = 'MD'
ON CONFLICT DO NOTHING;

INSERT INTO member_status (member_id, status_key)
SELECT m.id, (ARRAY['available','busy','on_scene','off_duty','at_hq'])[
         1 + (row_number() OVER (ORDER BY m.id))::int % 5]
FROM organization_member m JOIN user_account u ON u.id = m.user_id
WHERE u.username LIKE 'ui.%'
ON CONFLICT (member_id) DO NOTHING;
