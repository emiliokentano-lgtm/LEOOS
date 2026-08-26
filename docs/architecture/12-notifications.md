# 12 — Notifications and alerts

A notification is a **push of information**, which makes it a disclosure that
arrives unasked and is then stored where its recipient can read it at leisure.
This document records who receives what, why the audience is derived rather than
chosen, and why sound is never the alarm.

---

## 1. The property everything here exists to protect

**A notification's audience is exactly the set of people who could already have
seen the thing by looking.**

Telling a PD officer "FIB unit SIERRA-2 is in panic at Vespucci" leaks a covert
unit's position as surely as putting it on their map — more so, because it
arrives without being asked for and lands in a table they can re-read.

The defence is structural, in three parts:

| Mechanism | Where |
| --- | --- |
| **No contract type carries a recipient list.** Not `NotificationDto`, not `AnnouncementInput`, not the socket payload. The shape refuses the mistake, the same way the FiveM telemetry type has nowhere to put an organization. | `packages/contracts/src/notifications.ts` |
| **Every audience is computed from membership and permission**, inside the transaction, from the resource's own organization — never from a request body (engineering rule 11). | `apps/api/src/modules/notifications/recipients.ts` |
| **The permission checked is the one the screen uses.** A panic goes to holders of `dispatch.view` in the panic's organization — the identical predicate that gates the `org:<id>:panic` topic and the dispatch board. | same, and `apps/api/src/realtime/topics.ts` |

`HOLDS_PERMISSION` is written **once**, in SQL, mirroring the kernel's
`effectivePermissions`: deny overrides win outright, an organization lead holds
every organization-scoped permission, role grants and grant-overrides both
count, and expired overrides grant nothing. Two copies of "does this member hold
this permission" is how one of them ends up missing the override table.

This is asserted three ways: in `apps/api/test/notifications.test.ts`, and in a
real browser in `apps/web/scripts/notification-check.mjs`, where a PD officer
with `dispatch.view` denied by a member-level override sits in the right
organization at the right moment and is **not** told about the panic — while
still receiving the organization announcement they are entitled to.

---

## 2. Rows inside the transaction, delivery after the commit

The same rule the audit log follows, for the same reason.

```
db.transaction(tx => {
  … mutate …
  writeAudit(tx, …)                       ← the record
  createNotifications(tx, audience, …)    ← the rows
  return { result, events }               ← a DESCRIPTION of what to deliver
})
                                          ← commit
publishDispatchEvents(publisher, actor, events)   ← the route, afterwards
```

`createNotifications` takes a transaction handle, so a rolled-back assignment
leaves no "you were assigned" sitting in somebody's bell. Delivery travels in
the existing `DispatchEmission` envelope, which the services **return** rather
than publish — they have no publisher at all, so publishing inside a transaction
is not something a reviewer has to catch (see [realtime §4](03-realtime.md) and
`dispatch.events.ts`).

A crash between the two loses a real-time toast, not the notification: the row
is committed, the badge is right on the next poll, and the centre shows it. That
is the correct direction to fail in.

---

## 3. Who is told what, and who is deliberately not

A board that updates live already tells a dispatcher who is watching it. A
notification is for the person who is **not** watching — so each audience is the
smallest set that would otherwise miss something they need. Notifying more
widely is not "safer": a dispatcher with two hundred unread entries has a
notification centre they no longer read, and the panic lands in it.

| Event | Audience | Severity |
| --- | --- | --- |
| `panic.triggered` | `dispatch.view` in the panic's organization, **never filtered by duty** | critical |
| `panic.resolved` | the same audience | info |
| New call at P1 | dispatchers who can see it (owner + every organization with a unit on it) | critical |
| Escalation **to** P1 | those dispatchers **and** the crews already on it | critical |
| De-escalation | nobody | — |
| Call details / status changed | the crews on it | info |
| Call closed or cancelled | the crews that were on it | info |
| Unit assigned to a call | the crew of that unit | follows the call: critical at P1, else warning |
| Unit cleared from a call | that unit's crew | info |
| Note added to a call | **nobody** | — |
| Somebody joins your unit | the crew already in it | info |
| Somebody leaves, or the unit is disbanded | the remaining crew / the crew | info / warning |
| Organization announcement | every active member | info or warning, never critical |
| Account reinstated | the account holder | info |
| Capability granted or revoked | the account holder | warning |

**The actor is excluded everywhere.** Telling somebody what they just did is
noise that pushes down the things they did not do, and on a panic it would put a
copy at the top of the list of the one person who cannot act on it.

### Four deliberate silences

- **Notes notify nobody.** Notes are the highest-frequency thing on a call by an
  order of magnitude. One notification each is how a centre fills with entries
  nobody reads — and how the panic in the same list gets missed. A note can also
  name a suspect or a medical detail, and a notification row is stored where its
  recipient can re-read it; keeping notes out keeps that behind the authorized
  read.
- **De-escalation notifies nobody.** Nobody needs interrupting to be told
  something became less urgent.
- **Reopening a call notifies nobody.** Closing released every unit, so there is
  no crew to tell; it becomes notifiable again the moment somebody escalates or
  assigns to it.
- **Suspension and disabling notify nobody.** A disabled account cannot sign in
  to read its own notification. Reinstatement *is* notified, because that person
  can. The audit row is where the suspension lives.

### The multi-agency case

A joint call has **no owning organization**, so scoping to
`incident.organization_id` would notify nobody — the same failure the dispatch
topics already solve. `dispatchersForIncident` unions the owner with every
organization that has a unit on the call, and deduplicates by user, so somebody
with two of the involved memberships gets one entry rather than two identical
ones.

A brand-new multi-agency P1 with no units yet therefore reaches nobody, exactly
as its board event does. That is honest: nobody is on it.

---

## 4. What travels over the socket

```ts
interface NotificationPayload {
  id; type; severity; title; body; tone; target;
}
```

Identifiers and the handful of fields a client needs to **decide** — an icon, a
sound, whether the toast stays. `href` is deliberately absent: routing belongs to
the web app, and the client refetches the head of its list on arrival anyway.

That refetch is not an optimisation, it is the only correct design:

> **The badge cannot be computed from events.** The same person reading a
> notification in another tab lowers the count with no event at all. Only the
> server knows the number, so the server is asked.

The topic is `user:<id>`, which is refused to everybody but its owner on **every
delivery**, not cached at subscribe time. No permission grants access to another
person's stream, including a global administrator's: there is no operational
reason to read somebody else's notifications, and the capability would be pure
surveillance.

---

## 5. Sound is never the alarm

The brief is explicit that sound must not be relied on. Everything below it in
this section follows from that.

- **Sound is OFF by default**, with "critical only" on underneath it. An
  application that makes noise on first use gets muted at the operating-system
  level — and then the panic tone is muted too, which is worse than never having
  had sound.
- **Two gates, not one.** `shouldPlaySound(type, severity, preferences)` requires
  the type to be audible *at all* (a property of the catalogue) **and** the
  operator to have enabled sound **and** the critical-only filter to pass. Only
  `panic.triggered`, `incident.critical` and `incident.assigned` are audible.
- **The tone is synthesised**, not shipped: no asset, no MIME negotiation, no
  licensing question, and it cannot become a 404 that turns into silence in
  production.
- **It is allowed to fail completely and silently.** A browser that has not seen
  a click refuses to start an `AudioContext`; every path in `alert-tone.ts`
  returns without throwing, and nothing checks whether it worked.

Every notification that can make a sound is already visible without one: a
toast, a number on the bell, an entry in the centre, and for a panic an
unfilterable alert bar on the map ([map §9.4](05-map.md)) and a row on the
dashboard ([dashboard §1](10-dashboard.md)).

### Cues: sound for things that are not notifications

Sound started out driven entirely by notifications. That covers events pushed to
you from elsewhere and cannot cover the thing operators asked for first — **the
confirmation that your own action landed**. Setting your status raises no
notification to you, by design (you are not told about what you just did), so
there was nothing for a tone to hang on.

A **cue** has two sources and one player:

| Source | Example | Fired from |
| --- | --- | --- |
| Remote | a panic, a backup request, an assignment | the notification arrives → `cueForNotification(type)` |
| Local | your status changed; a chat message landed | the screen that already re-read the data |

The rule that keeps this honest: **a cue is fired from the same place that
already updated the screen** — after the server said yes, never on the click,
never from a second fetch. A confirmation tone for something that was then
refused tells an operator their status changed when it did not.

**The gates compose, they do not replace one another.** A notification-sourced
cue must pass `shouldPlaySound` (is the type audible at all, is sound on, does
the critical-only filter allow it) *and* `shouldPlayCue` (has the operator
silenced this cue). Neither can widen the other, which is what keeps "a tone for
a task would train operators to ignore the tones that mean something is
happening now" true now that cues exist — there is no task cue at all, rather
than one that could never sound. A test asserts that every entry in the
notification→cue map is a type the catalogue already marks audible.

**The shapes are data.** `SOUND_CUES` in `packages/contracts/src/sound.ts` gives
each cue a label, a description the settings screen renders, a tone as a list of
notes, and a minimum gap. The player knows how to play a sequence of notes and
nothing about what any cue means, so adding one is a table entry rather than a
branch. The tones are shaped to be told apart without looking — panic is the
longest and the only one that repeats; the most frequent cue, a chat message, is
the shortest and lowest, because the cue you hear most must be the least
intrusive or it is the one that gets sound turned off entirely.

**A burst is collapsed into one cue.** Every cue but panic carries a `minGapMs`;
an operator being machine-gunned by their own notification sound turns sound off
and loses the panic cue with it. Panic's gap is `null` — two panics four seconds
apart are two panics, and that is exactly when both must be heard.

**The settings screen says what it can actually do.** A browser that has not seen
a click refuses to start an `AudioContext`, so the panel reports *"Your browser
has not allowed sound yet"* rather than showing a switch that is on and silent,
and every cue has a preview button — an operator deciding whether to keep a
sound needs to hear it, and a screen that makes you provoke a real panic to find
out is not one.

### Panic cannot be muted

Enforced in three places, each sufficient alone:

| Where | Mechanism |
| --- | --- |
| `packages/contracts` | `UNMUTABLE_CATEGORIES` — `canMuteCategory('panic')` is false, and `isMuted` returns false for panic whatever is stored |
| the API | `writePreferences` strips it on the way in **and on the way out**, so a row restored from an old backup produces a client that shows panics, not one that hides them |
| the database | `notification_preference_panic_unmutable` CHECK — a support script editing the row by hand is refused too |

The **panic cue** is protected the same way and in the same four places:
`UNMUTABLE_CUES` in the contracts, `sanitizeCues` stripping it on the way in,
the same function stripping it again on the way **out** so a row from an older
backup produces an operator who hears panics rather than one who does not, and
`notification_preference_panic_cue_unmutable` in the database.

The screen says why, in words, rather than offering a disabled control with no
explanation: *"Panic — always shown"*.

A muted category is still **written, still counted, still listed**. Muting stops
the banner and the sound; it does not conceal. An operator who muted "units" has
said "stop interrupting me about crew changes", not "hide them from me", and a
notification the client threw away would be one the badge then contradicts.

---

## 6. Announcements — the one notification a human composes

Everything else is emitted by the domain event that caused it, which is what
makes it unforgeable. This is the exception, so it is narrowed on every axis:

- the **audience** is not chosen — every active member of one organization,
  derived inside the transaction. There is no recipient parameter to supply;
- the **organization** comes from the path and must equal the actor's active
  organization; a foreign id is a 404, not a 403, so a caller learns nothing
  about organizations they are not in;
- **`critical` is refused** — by the route schema, and again by the service, so
  posting around the schema still cannot produce a critical announcement. Critical
  is what a panic uses; an announcement that can dress as one is how people learn
  to dismiss the level that matters;
- it is **audited**, as `announcement.sent`, with the title, the level and the
  recipient count. The composer says so before the operator sends.

The audit action is deliberately *not* named `organization.announcement_sent`:
`organization.` is a privileged prefix in `auditSeverityOf`, and classifying every
routine shift notice as high severity would bury the organization changes that
prefix exists to surface.

---

## 7. Reading, paging and retention

- **Every route is scoped to the caller in SQL, with no parameter.** There is no
  `userId` in any path, query or body — `request.auth!.userId` is the only source.
  A notification list is a summary of everything its owner has been told, which
  is a richer disclosure than any single screen.
- **Marking another person's notification read is worse than reading it** — it
  removes the badge that would have made them look. An id belonging to somebody
  else matches nothing and the call reports zero, rather than a 403 that would
  confirm the id exists.
- **Keyset paging**, like the audit log. Notifications arrive at the head while
  the centre is open; an offset would repeat and skip rows as they do.
- **Filtering happens at the API, over the whole feed.** Filtering the page that
  happened to be loaded would make "show me every panic" mean "show me the panics
  among the last twenty rows", which reads as a quiet shift rather than as a
  filter that did not do what it said.
- **Retention deletes read notifications past the window; unread ones are never
  deleted by age.** Somebody back from two weeks off should still see that they
  were assigned to something. The audit log is the record that survives —
  notifications are operational ephemera.

---

## 8. What the walkthrough found

`apps/web/scripts/notification-check.mjs` runs against a live stack and earned
its keep on the first pass: it found that an operator with an active membership
but **no `dispatch.view`** rendered the live dashboard, whose poll could only
ever be refused — so the screen reported *"lost contact with the server"* every
few seconds while nothing was wrong.

The fix follows the precedent set for `/api/dispatch/self`: a refusal is an
**answer**, not an outage. `fetchDashboard` now returns a three-way result, and
the page renders an honest empty state that says the account lacks the
permission, instead of starting a poll it knows will fail.

---

## 9. How each rule is enforced

| Rules | Mechanism | Location |
| --- | --- | --- |
| 9, 10, 11 | Recipients derived from membership and permission inside the transaction; the permission is the one the screen uses. No contract type can carry a recipient. | `apps/api/src/modules/notifications/recipients.ts` |
| 12 | The one human-composed notification takes its organization from the path and refuses anything but the actor's own; `critical` is refused by schema and by service. | `announcement.service.ts` |
| 16 | Responses are built from `NotificationDto`, never from a row. A test searches every notification response for credentials — and for the incident description and caller phone the notification deliberately does not carry. | `notification.dto.ts`, `apps/api/test/notifications.test.ts` |
| 18 | Zod, `.strict()`, on every route; an unknown preference is a 400, not a silent drop. | `notification.routes.ts` |
| 21, 22 | The badge is one partial-index scan and is a different request from the page; the socket is the fast path with a 30-second backstop behind it; read notifications are purged past the window. | `notification.service.ts`, `notification-context.tsx` |
| 23 | Rows are written in the same transaction as the change and the audit row; announcements have their own audit action. | this document, §2 |
| 26 | Loading, error, empty and filtered-empty are distinct states in the centre; a muted category is disclosed rather than hidden. | `notification-centre.tsx` |
| 27 | One `NotificationItem`, shared by the bell and the centre at two densities. | `components/domain/notification-item.tsx` |
| 5, 6, 7 | The type catalogue is data: icon, tone, category and audibility come from a table, so adding a type is one entry rather than a branch in five components. | `packages/contracts/src/notifications.ts` |
| 31, 32 | Audience derivation, feed privacy, panic un-mutability and the sound policy are release-gate tests. | `apps/api/test/notifications.test.ts` |
| 34, 35, 45 | Sound is off until asked for, and the screen says in plain words that sound is never the alarm. The announcement reports the count the **server** returned, not the roster size the screen rendered. | `notification-centre.tsx`, `announcement-composer.tsx` |
| 40 | The walkthrough is a release gate, and it found a real defect on its first run. | §8 |
