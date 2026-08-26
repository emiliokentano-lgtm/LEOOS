# Chat

Direct messages and groups, with records linked inline.

The feature is ordinary. Two things about it are not, and both are decided here
before any code: **it is the first free text this system puts on the real-time
socket**, and **a link to a record must never reveal that record to somebody not
entitled to see it**.

---

## 1. The conflict, and how it is resolved

### The rule chat collides with

Event payloads in LEOOS carry identifiers and the handful of fields a screen
needs to know something moved — **never a description, a note body, a caller's
phone number, an email or a rank**. That is not a convention: it is asserted by
tests that search the *whole serialised frame* for planted strings
(`realtime.test.ts`, "carries no sensitive detail in an incident payload" and
"a note reaches the board without the note's text").

The rule exists because a socket frame is delivered to everyone subscribed to a
topic, and topic authorization is coarser than record authorization. An incident
description reaching every console with `dispatch.view` would be a leak the REST
layer would never have permitted.

Chat is free text by definition. So one of two things has to give.

### The two options

**Option A — carry the message body over the socket.** The client renders it the
moment it arrives, with no follow-up request. Fast, simple, and it makes chat an
exception to a rule the rest of the system holds, which means the leak test has
to learn about that exception, which means the test that protects everything
else grows a hole shaped like chat.

**Option B — carry only `conversationId` and `messageId`; the client fetches the
message over REST.** One extra round trip per message. The rule stays intact and
so does its test.

### The decision: Option B, and it is not a close call

Three reasons, in the order that decided it.

**1. The body could not be rendered from the socket anyway.** A message can link
a person, a vehicle or an incident, and *a link resolves differently for
different viewers* — a doctor sees a name where an officer sees "not available
to you". A frame carrying a ready-to-render message would have to be built
per-recipient, at which point it is not a broadcast, and the round trip it was
meant to save has been spent on the server instead.

**2. Membership can change between publish and delivery.** Every other topic in
this system is re-authorized on every delivery precisely so a demoted operator
stops receiving on the next event. If the frame carries the body, a race between
"removed from the conversation" and "message published" leaks a message to
somebody who has just left it. With an identifier, the worst case is a fetch
that returns 404 — which is the correct answer.

**3. The exception would not stay one.** A leak test with a carve-out for chat is
a leak test somebody adds a second carve-out to. The rule's value is that it has
none.

The cost is honest and worth stating: **a message arrives in two steps, and on a
slow link the second can fail.** The client shows the conversation as having
something new and retries; it does not silently drop the message, and the
30-second poll behind the socket picks it up regardless.

### What this means in the code

`message.created` carries exactly `{ conversationId, messageId, authorMemberId }`.
No body, no preview, no author name. `realtime.test.ts` gains a chat case that
plants a string in a message and asserts it never appears in a frame — the same
shape as the incident and note cases, extending the rule rather than exempting
chat from it.

---

## 2. Links, and the leak they could be

A message can reference a person, a vehicle, an incident, a unit or a member.
The reference is stored as a **typed identifier**, never as pasted text.

### Resolution is per viewer, server-side

Two people reading the same message may correctly see different things:

| Viewer | Sees |
| --- | --- |
| An officer with `persons.view` | The person's name |
| A mechanic without it | `Record not available to you` |

The preview is built in the API's read path, using **the same redaction the
person and vehicle read paths already apply**. There is no second set of rules to
drift from the first, and no code path that resolves a link without going
through them.

### Why the identifier is still stored

A link whose target the viewer may not see still renders — as a redacted chip,
not as nothing. Removing it would change the *shape* of the conversation
depending on who is reading, and "there is something here you cannot see" is
both true and less confusing than a sentence with a hole in it.

The chip carries no identifier the viewer could act on: it is a label and a
type, and clicking it does nothing.

### The test that matters

A doctor and an officer read the same message linking a person who has both a
medical record and a criminal record. Each sees the half they are entitled to,
and the other half is absent from the response body — not hidden by CSS,
absent.

---

## 3. Who may talk to whom

| Action | Rule |
| --- | --- |
| Start a direct message | Both people are active members of a shared organization |
| Create a group | An active membership; the creator is its first member |
| Add somebody to a group | Be in the group, and they share the organization |
| Leave a group | Always allowed |
| Remove somebody else | The group's creator only |
| Read a conversation | Be a current member of it |
| Post | Be a current member of it |

**No permission gates ordinary conversation.** Talking to a colleague is not a
privilege an organization grants, and gating it would produce members who can see
a dispatch board and cannot ask a question about it. What *is* gated is
everything a message can reach — links resolve per viewer, so a conversation
grants no access its participants did not already have.

**A conversation belongs to an organization.** Cross-agency chat is deliberately
absent: it would need a home organization for authorization, an audience rule
that spans two permission sets, and a retention policy two agencies would have to
agree on. It is a feature, not an oversight, and it is listed in the project
report's limitations rather than half-built.

### Membership is checked on every read and every delivery

Not cached at subscribe time — the same rule the map and dispatch topics follow.
Somebody removed from a group stops receiving on the next message, with no
revocation machinery, because there is nothing cached to revoke.

---

## 4. Editing, deleting and what survives

| | |
| --- | --- |
| **Edit** | Not offered. A message somebody acted on must not change afterwards. |
| **Delete own message** | Soft. The row stays; the body is replaced with a tombstone the reader sees as "message deleted". |
| **Delete a conversation** | Not offered. |

Deletion is soft because an operational conversation is a record: "who told me
to go there" is a question asked afterwards, and a hard delete lets one
participant remove the answer. The tombstone is visible so the conversation's
shape does not silently change.

**Retention.** Messages are kept for 180 days, then purged by the same hourly
sweep that purges notifications and expired sessions. A conversation with no
messages left is not deleted — an empty thread with its participants is cheap
and a missing one is confusing.

---

## 5. What is audited, and what is not

**Not every message.** An audit row per message would double the write volume of
the busiest table in the system and bury the administrative events the log exists
to surface, in exchange for recording something already recorded — the message
itself.

Audited: **creating a conversation**, **adding or removing a participant**, and
**deleting a message**. Those are the things a dispute turns on, and the last of
them is the only one that destroys information.

---

## 6. Performance

- The conversation list is one indexed query per user, ordered by last activity,
  and does not read message bodies.
- A thread pages by **keyset**, not offset: a conversation grows at the head
  while somebody reads it, and an offset silently repeats and skips rows — the
  same reason the audit log pages this way.
- Link previews are resolved in **one batched query per entity type per page**,
  not one per link. A message with six links costs at most five queries for the
  whole page, not six per message.
- The unread count is a partial-index scan and a different request from the
  thread, like the notification badge.
