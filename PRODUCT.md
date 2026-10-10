# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Delivered as three surfaces of one product: a self-hosted server, a React web UI, and a
browser extension (Chrome/Edge/Firefox, MV3). An external REST API is a fourth surface with
no UI of its own.

## Users

The primary user is the person who installs and runs the instance themselves, and who is
also its administrator and its syncing user. They pair devices, read diagnostics, decide
what to do when a reconciliation is ambiguous, and live with the result for years. They are
technical enough to run a binary and a SQLite file, but they are not looking at this tool
every day — they come back to it when something is wrong or when a new browser appears.

Secondary audience, confirmed by scope rather than by current deployment: family or small
circle members on the same instance, each owning private Spaces and never administering
anything (docs/00 §1).

## Product Purpose

Pontis is a self-hosted, cross-browser **native** bookmark sync platform. It syncs the
browser's own Bookmark/Favorites tree in Edge, Chrome and Firefox instead of replacing it
with a read-it-later app or a separate favorites store. The user keeps browser-vendor sync
for passwords, history and extensions, and turns off only Favorites/Bookmarks sync.

Success means the tree on every browser converges to the server's canonical state without
the user losing anything they created, including while offline, and that a breakage tells
them what broke and what the recovery is.

## Positioning

The mechanism a neighboring product could not copy by rewriting its UI:

- The server is the single source of truth. Browsers are replicas that converge on the
  canonical tree — not peers exchanging diffs (docs/00 §2.1).
- Sync operates on the browser's native tree through a real protocol (Operation → Canonical
  Change → Revision, watermarks, receipts), so a browser folder is the artifact, not an
  import of it.
- Browser IDs never leave the device. A Binding is `Device × Space`, and a Mount maps a
  local folder to it (docs/README 文档约定).
- Ambiguity is escalated to the user instead of being guessed: reconciliation plans carry
  questions, and a plan is not committed until they are answered.
- One Go binary + SQLite + a data directory, with the web UI embedded in the release build.
  No Node.js at runtime, no external queue or database.

## Operating Context

- Install and upgrade: run a single binary against a data directory; the extension installs
  from an unpacked or packaged build and is versioned independently of the server, with
  compatibility decided by Sync Protocol version.
- Everyday loop: pair a device (server URL + login + device registration) → bind a Space to
  a mount folder → the initial reconciliation runs and may ask questions → the binding goes
  active → edits are captured from browser events and uploaded; remote changes are applied
  back to the browser.
- The extension's service worker is killed and restarted by the browser routinely; work
  resumes from IndexedDB state rather than from memory.
- The user's own vocabulary is the docs' vocabulary: Canonical State, Device, Binding,
  Mount, Operation, Canonical Change, Journal, ChangeSet, Publication.
- Navigation is object-centered and fixed by docs/24: content workspace (Space / Plaza /
  Activity), user tasks (Tasks), personal and device (Devices / Settings), instance
  administration (Users / Background Jobs / System Settings).

## Capabilities and Constraints

Implemented and exercised in this repository: sync protocol with epoch/watermarks/receipts
and rebase; initial reconciliation and full resync with recovery; partial and full sync
mounts; multi-user auth with sessions, device credentials and API tokens; import/export;
organizer including link checking; background jobs, schedules and retention; backups and
restore; ChangeSet undo and activity; plaza/publication copies; diagnostics.

Hard constraints future work must respect:

- Single-instance SQLite deployment; no distributed consistency, no PostgreSQL abstraction,
  no Redis/RabbitMQ queue (docs/00 §3).
- V1 explicitly does **not** do: shared multi-editor Spaces, node ACL/group/team/workspace,
  event sourcing, auto-subscribing publications, fuzzy URL matching as sync identity, URL
  normalization in the sync layer, Firefox separators, a global Ctrl+Z undo stack, or default
  external telemetry. Designing a surface that implies any of these is out of scope.
- Each Space has exactly one owner; cross-user propagation happens only through an explicit
  Publication Copy.
- Administrators manage the instance; they do not get a product feature for reading other
  users' private bookmarks.
- `Settings` is always personal scope and `Administration` is always instance scope;
  independently manageable objects (users, jobs) get their own page and route; admin
  capability must not be discoverable only as a hidden button inside another page
  (docs/24 §10).
- User tasks and background jobs are two different product concepts and stay separate.
- The extension ships no analytics and stores its replica locally in IndexedDB.

Undecided / not yet established:

- No accessibility standard has been committed to in the product docs. docs/23 states density
  intent (compact, low-contrast borders, stable alignment) but no conformance target.
- No pricing, licensing, distribution channel or public instance policy is decided.
- Whether Firefox ships in the first public release is not settled; Chrome/Edge are the
  surfaces in use today.

## Brand Commitments

- Name: **Pontis**. Product version is still `0.1.0`; sync protocol version list is `[1]`.
- `docs/23-ui-design-system.md` ("Cold Rational Workspace") is binding for **every** surface,
  the browser extension included — confirmed by the owner. Its token set is implemented in
  `web/src/theme/pontis-theme.ts`, and `extension/src/theme/pontisTheme.ts` is a port of it.
  New work must not create a second color or spacing system.
- `docs/24-information-architecture.md` navigation invariants are binding.
- UI copy in the extension is Chinese; technical protocol terms (epoch, applied/received,
  error codes) stay in their protocol form.
- Existing assets: `web/public/favicon.svg`, `web/dist/favicon.svg`.

## Evidence on Hand

- Design corpus: `docs/00` through `docs/24` plus `docs/CHANGELOG-v1.2.md` — the product is
  specified in unusual depth before being widely used.
- Working code with tests on both sides: Go server suites (`server/internal/**`, including
  `syncsim` and fault injection) and the extension's vitest suites (`extension/src/core/**`).
- A real local alpha instance: server on `127.0.0.1:8080` with SQLite at `~/.pontis-alpha`,
  and real Chromium profiles that have completed pairing, initial reconciliation, ambiguity
  resolution, mid-apply crash recovery, unbind/rebind, and two-device convergence.
- Screenshots of the extension's options and popup surfaces in light and dark.

Absences that future work must not fabricate: no real external users or deployed instances,
no testimonials, no customer names, no case studies, no benchmarks, no comparative
performance data, no press, no security audit, no published SLA. This is pre-alpha software
used only by its author.

## Product Principles

1. **The server is the truth; browsers converge on it.** A replica may be offline, stale or
   broken, but convergence is always toward the canonical tree.
2. **User-created data never disappears silently.** Losing a stale mutation is acceptable;
   losing something the user actually created is not, and recovery paths (such as a
   `Recovered/<Device>` folder) exist for exactly that case.
3. **A delete is not quietly resurrected.** DELETE outranks a stale UPDATE or MOVE from an
   old client.
4. **Private by default, including from the admin.** Sharing is an explicit act that produces
   a copy, and administration never grants reading someone's bookmarks.
5. **Correctness first.** Reliability beats real-time, minimal operation counts, clever
   automatic merges, or horizontal scale.
