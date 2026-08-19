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

-- ── Registers ──────────────────────────────────────────────────────────────
-- Persons, vehicles, units and incidents for the browser walkthroughs. Kept in
-- this file rather than run ad hoc, because the database test suite drops the
-- schema and anything seeded outside here does not survive it.

WITH people(first_name, last_name, dob, phone, address, status) AS (VALUES
  ('Marisol','Reyes','1991-03-14','555-0148','412 Vespucci Blvd','alive'),
  ('Dwayne','Okafor','1985-07-02','555-0177','88 Grove Street','alive'),
  ('Bianca','Ferretti','1996-12-30','555-0102','7 Rockford Drive','alive'),
  ('Anders','Holm','1978-05-21','555-0139','19 Paleto Way','incarcerated'),
  ('Junko','Watanabe','2000-01-09','555-0166','3 Mirror Park Ave','alive'),
  ('Terrence','Boyle','1969-11-11','555-0121','55 Sandy Shores Rd','missing'),
  ('Elif','Demirtas','1993-08-26','555-0195','21 Little Seoul','alive'),
  ('Ruben','Castellanos','1988-02-05','555-0183','9 Chumash Plaza','alive')
)
INSERT INTO person (first_name, last_name, date_of_birth, phone_number, address, status, is_deceased)
SELECT first_name, last_name, dob::date, phone, address, status::person_status, false
FROM people
WHERE NOT EXISTS (
  SELECT 1 FROM person p WHERE p.first_name = people.first_name AND p.last_name = people.last_name);

INSERT INTO person_alias (person_id, alias)
SELECT p.id, a.alias FROM person p
JOIN (VALUES ('Reyes','Sol'), ('Okafor','Big D'), ('Holm','The Swede')) AS a(surname, alias)
  ON p.last_name = a.surname
ON CONFLICT DO NOTHING;

INSERT INTO person_flag (person_id, type, severity, note)
SELECT p.id, f.type, f.sev::flag_severity, f.note FROM person p
JOIN (VALUES
  ('Holm','armed and dangerous','critical','Firearm recovered at last stop.'),
  ('Boyle','mental health caution','caution','Approach with EMS support.'),
  ('Okafor','known to flee','caution',NULL)
) AS f(surname, type, sev, note) ON p.last_name = f.surname
ON CONFLICT DO NOTHING;

INSERT INTO warrant (person_id, organization_id, type, reason)
SELECT p.id, (SELECT id FROM organization WHERE key='PD'), 'arrest', 'Failure to appear'
FROM person p WHERE p.last_name = 'Holm'
  AND NOT EXISTS (SELECT 1 FROM warrant w WHERE w.person_id = p.id);

INSERT INTO medical_record (person_id, blood_type, allergies, conditions, emergency_contact)
SELECT p.id, 'O-', ARRAY['Penicillin'], ARRAY['Asthma'], 'Sister — 555-0190'
FROM person p WHERE p.last_name = 'Reyes'
ON CONFLICT (person_id) DO NOTHING;

INSERT INTO criminal_charge (person_id, title, severity, status)
SELECT p.id, 'Grand theft auto', 'felony', 'convicted'
FROM person p WHERE p.last_name = 'Holm'
  AND NOT EXISTS (SELECT 1 FROM criminal_charge c WHERE c.person_id = p.id);

INSERT INTO vehicle (plate, model, display_name, color, vehicle_class, owner_person_id,
                     registration_status, insurance_status)
SELECT v.plate, v.model, v.display_name, v.color, v.class, p.id,
       v.reg::vehicle_registration_status, v.ins::vehicle_insurance_status
FROM (VALUES
  ('46EEK572','sultan','Karin Sultan','Black','Sports','Reyes','registered','insured'),
  ('8HGX1120','buffalo','Bravado Buffalo','Blue','Muscle','Okafor','expired','uninsured'),
  ('LSPD0091','police3','Interceptor','Black/White','Emergency','Ferretti','registered','insured'),
  ('K7T44PQ','blista','Dinka Blista','Red','Compact','Watanabe','registered','insured'),
  ('RUSTBKT','rebel','Rusted Rebel','Brown','Off-road','Holm','unregistered','uninsured')
) AS v(plate, model, display_name, color, class, surname, reg, ins)
JOIN person p ON p.last_name = v.surname
WHERE NOT EXISTS (SELECT 1 FROM vehicle x WHERE x.plate = v.plate AND x.deleted_at IS NULL);

INSERT INTO vehicle (plate, model, display_name, color, owner_organization_id, is_fleet,
                     registration_status, insurance_status)
SELECT f.plate, f.model, f.display_name, f.color,
       (SELECT id FROM organization WHERE key = f.orgkey), true, 'registered', 'insured'
FROM (VALUES
  ('LSPD1401','police','Cruiser 14','Black/White','PD'),
  ('EMS0302','ambulance','Rescue 3','White','MD'),
  ('FIB0007','fbi','Unmarked','Grey','FIB')
) AS f(plate, model, display_name, color, orgkey)
WHERE NOT EXISTS (SELECT 1 FROM vehicle x WHERE x.plate = f.plate AND x.deleted_at IS NULL);

INSERT INTO vehicle_flag (vehicle_id, type, note)
SELECT v.id, 'stolen', 'Reported taken from Vinewood.' FROM vehicle v WHERE v.plate = 'RUSTBKT'
  AND NOT EXISTS (SELECT 1 FROM vehicle_flag f WHERE f.vehicle_id = v.id);

INSERT INTO unit (organization_id, callsign, name, unit_type, status_key)
SELECT (SELECT id FROM organization WHERE key = u.orgkey), u.callsign, u.name, u.utype, u.skey
FROM (VALUES
  ('PD','1-ADAM-12','Adam Twelve','patrol','available'),
  ('PD','1-LINCOLN-10','Supervisor 10','supervisor','busy'),
  ('PD','AIR-1','Air Support','air','at_hq'),
  ('MD','MEDIC-3','Rescue Three','ems','on_scene'),
  ('FIB','SIERRA-1','Field Office','investigation','available')
) AS u(orgkey, callsign, name, utype, skey)
WHERE NOT EXISTS (SELECT 1 FROM unit x WHERE x.callsign = u.callsign AND x.status = 'active');

INSERT INTO incident (organization_id, title, description, priority, status, location_text, closed_at)
SELECT (SELECT id FROM organization WHERE key = i.orgkey), i.title, i.descr,
       i.prio, i.status::incident_status, i.loc,
       -- A closed incident must record WHEN it closed (incident_closure_complete).
       CASE WHEN i.status = 'closed' THEN now() ELSE NULL END
FROM (VALUES
  ('PD','Burglary in progress','Rear door forced.',1,'dispatched','412 Vespucci Blvd'),
  ('PD','Traffic collision','Two vehicles, minor injuries.',3,'on_scene','Route 68 at Zancudo'),
  ('MD','Cardiac arrest','Bystander CPR in progress.',1,'on_scene','Mirror Park Ave'),
  ('FIB','Surveillance detail','Ongoing federal matter.',4,'pending','Downtown'),
  ('PD','Shoplifting report','Suspect left on foot.',4,'closed','Rockford Hills')
) AS i(orgkey, title, descr, prio, status, loc)
WHERE NOT EXISTS (SELECT 1 FROM incident x WHERE x.title = i.title);
