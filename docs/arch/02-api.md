# 02 — The HTTP surface: contract, status discipline and what an unjoined caller may reach

**IDs:** `XR-API-nn`
**Repo root for every path below:** `/local/home/angryang/.kiro/crew/workspace/Encore-ux` (branch
`refactor/test-architecture-775`, HEAD `366c60b`). Paths are repo-relative.

---

## What this section covers

Sixteen source files under `apps/core/src/routes/api` are the app's only non-websocket seam, and they
had **no requirement coverage at all** before this section. The websocket is where the party happens
and is where the design attention has gone; HTTP is where a guest joins, searches, pays for compute,
changes deployment policy and hard-deletes a song from the library — and where anything on the LAN that
is not a browser arrives.

The rows below govern the **contract**, not the behaviour behind it: the shape of a refusal, which
status code a fault gets, whether a request may be safely retried, what a body is allowed to contain,
and what an unauthenticated caller may do and learn. They deliberately do not restate what each endpoint
computes — that is `../ARCHITECTURE.md` — and they do not reopen the authority policy, which is ruled and
published in [`../ux/05-concurrency.md`](../ux/05-concurrency.md) § "Owner rulings". Where a row touches
authority it is about **how a refusal is expressed over HTTP**, which those rulings do not address.

**Consumers, verified by call site.** The phone (`routes/+page.svelte`, `lib/components/JoinLanding.svelte`,
`routes/settings/+page.svelte`) reads join, room-preview, me, leave, library, search, make-karaoke,
lyrics-reselect and settings. The operator pages (`routes/admin`, `routes/metrics`,
`routes/metrics/[mediaId]`, `routes/stats`) read library, delete-media, metrics, audit and stats. **The TV
fetches nothing** — `routes/tv/+page.svelte` contains no `fetch(` at all and lives entirely on the
websocket, which is why "TV" is exempt on almost every row rather than merely unmentioned.

---

## Four things reading the code contradicted

Recorded because each was expected to go the other way, and three of the four are what the rows are for.

| Expected | The code actually says | Consequence |
|---|---|---|
| `/api/thumb` proxies a caller-supplied URL, so it is an SSRF hole | `server/media/thumbs.ts:12-33` carries an explicit SSRF guard — https-only plus a five-host allowlist, with the metadata-endpoint attack named in the comment | **No row.** The one endpoint that takes a URL from the caller is the best-defended in the set. `serveThumb` also has the only bounded upstream fetch (`thumbs.ts:55`, 5 s) |
| The API has an error envelope, applied unevenly | There is no envelope anywhere. Thirteen sites hand-write `json({ error }, { status })`, `audit/[mediaId]/+server.ts:20,26` throws SvelteKit's `error()` instead, `me/+server.ts:19` answers `{ singer: null }`, and `thumb/+server.ts:7` answers `text/plain` | `XR-API-01`. There is no `hooks.server.ts` in the app (`apps/core/src/hooks.server.ts` does not exist), so no layer exists that *could* impose one |
| A paste into the lyrics re-select is stored | `lyrics-reselect/+server.ts:41` reads `body.text`, line 44 branches on it, and the text is then **dropped**: `pinnedText` is declared (`packages/shared/src/core/events.ts:272`) and consumed by the worker (`apps/worker/src/steps/lyrics.py:830`), but `dispatch.ts:108` sends only `pinnedRef` and **no TypeScript file anywhere sets `pinnedText`** | `XR-API-06`, and it is the most serious row here. The endpoint answers **200 with a job id** for a request whose entire payload it discarded |
| Two unauthenticated GETs are read-only, as their headers say | `library/+server.ts:7` and `stats/+server.ts:3` both describe `/api/search` as "read-only". `search/+server.ts:94` inserts a durable media row per hit and `:89` mutates a stored one in place | `XR-API-09`. The search header itself is honest ("materializes + persists each hit", `:5`) — the two files describing it are not |

### Negative findings — what was searched for and not found

- **No schema validator is a dependency of any package.** `zod`, `valibot` and `ajv` are absent from
  every `package.json`. Every body check in the tree is a hand-written `typeof body.x === 'string'`, so
  `XR-API-05` is a requirement to adopt something, not to use something already present.
- **No rate limiter exists.** The only HTTP 429 in the app is the per-singer cook cap
  (`make-karaoke/+server.ts:52`). Nothing bounds request rate on any endpoint, authenticated or not.
- **No request body size limit is declared in a tracked file.** `git ls-files` matches no
  `svelte.config.*` at all, and the Bun.serve entry (`apps/core/server.ts:183`) sets no
  `maxRequestBodySize` — the string appears nowhere in tracked source. The adapter is
  `svelte-adapter-bun` (`apps/core/package.json:40`); `apps/core/build/` is generated and untracked, so
  it is not evidence about configuration.
- **No test in the repository asserts a status code, an error body shape, or an auth gate for any
  route under `routes/api`.** Nine route tests exist under `tests/unit/core/routes/api/` and each
  covers that endpoint's *computation* — the presence intersection, the room-id fallback, the tag map,
  the not-cookable arm. `tests/guards/wiring/capability-wiring.test.ts` reads `hub.ts` and nothing else
  (it contains no occurrence of `settings`, `routes/api` or any route path), so both HTTP `can()` call
  sites are unguarded. That is `XR-API-12`, and it is why almost every `Check` below names a file that
  does not exist yet.

---

## Group A — The envelope

### XR-API-01 — Every endpoint answers one error envelope

| Field | Content |
|---|---|
| **Statement** | Every failure response from `routes/api/**` carries the same JSON envelope — a human-readable `error` string plus an optional machine-readable `reason` code — and no endpoint answers a failure with a different body shape, a different key, or a non-JSON body. Named exemptions: `/api/thumb`, which serves image bytes and whose caller is an `<img>` element that reads no body. |
| **Surfaces** | Phone (renders `error` verbatim in a toast); operator pages (`routes/admin`, `routes/metrics`). TV exempt — it fetches no endpoint. |
| **Rationale** | The phone shows a refusal's text to a guest in a room full of people, so a consumer that must branch on three body shapes to find the sentence will eventually show the wrong one — or nothing — and the guest reads that as the product having no answer. |
| **Source** | Cited, and the divergence is measured. Thirteen sites answer `json({ error: … }, { status })` — for example `make-karaoke/+server.ts:15`, `delete-media/+server.ts:48`, `room-preview/+server.ts:29`. Three do not: `audit/[mediaId]/+server.ts:20` and `:26` call SvelteKit's `error(400, …)` / `error(404, …)`, which produces a `message`-keyed body or an HTML error page rather than `{ error }`; `me/+server.ts:19` answers a 401 as `{ singer: null }` with no error key at all; `thumb/+server.ts:7` answers `new Response('missing u', { status: 400 })`, a bare `text/plain` string. `reason` is already the emerging second half — `make-karaoke/+server.ts:38,50` and `lyrics-reselect/+server.ts:45,55` both send it, and nothing else does. |
| **Acceptance** | **Given** each exported handler under `routes/api/**`, **when** it is driven into every failure branch it can reach, **then** every response with a status ≥ 400 parses as JSON and carries a non-empty `error` string; **and** a single branch answering `{ message: … }`, `{ singer: null }` or a `text/plain` body falsifies it. |
| **Check** | A route-level test that imports each handler and asserts the envelope on every failure arm. **No such file exists** — the nine tests under `tests/unit/core/routes/api/` all assert computation, none asserts a body shape. The handler-driving harness is already proven and can be copied: `tests/unit/core/routes/api/room-preview/server.test.ts` installs an app under `Symbol.for('encore.app')` against `migratedDb()` and calls the real `GET`. |
| **Priority** | **Should ship.** Not blocking, because the phone's consumers each happen to match the endpoint they call today — which is exactly why this is cheap now and expensive after the next consumer is written against the wrong assumption. |

> **Recommendation (not decided).** Fix the three outliers rather than writing a middleware. There is no
> `hooks.server.ts` and adding one to normalise error bodies buys a layer that every future reader must
> learn, for three call sites. Convert `audit`'s two `error()` throws to `json({ error }, { status })`,
> give `me`'s 401 an `error` key beside its `singer: null`, and leave `/api/thumb` exempt in writing.

---

### XR-API-02 — "You have no session" is one answer, not four

| Field | Content |
|---|---|
| **Statement** | Every endpoint that requires a session answers a missing or unrecognised one with the **same** status and the **same** text, and that text is the room's words rather than each author's. |
| **Surfaces** | Phone (every write path, plus the cold-start `/api/me` probe). Operator pages (`delete-media`). TV exempt. |
| **Rationale** | A guest whose cookie was discarded hits several endpoints in one session and is told a different thing by each, so the one fault with a single remedy — join again — presents as several unrelated failures and none of them says to do that. |
| **Source** | Cited, and the four variants are exhaustive across the tree. `'join first'` at `leave/+server.ts:16`, `leave/+server.ts:25`, `me/+server.ts:31`, `settings/+server.ts:24`, `settings/room/+server.ts:19`. `'not joined'` at `make-karaoke/+server.ts:15`, `delete-media/+server.ts:23`, `lyrics-reselect/+server.ts:34`. `{ singer: null }` with no message at `me/+server.ts:19`. All four are status **401**, so the status is already consistent and only the text is not. The known cause of a discarded cookie is documented in the same tree — `join/+server.ts:24-27` records that marking the cookie `Secure` on a plain-HTTP LAN made `/api/me` 401 with no cookie to read. |
| **Acceptance** | **Given** a request with no session cookie, **when** it is sent to each session-requiring endpoint in turn, **then** every response is 401 and every `error` string is byte-identical; **and** two endpoints answering different text falsifies it. |
| **Check** | The same route-level test as `XR-API-01`, asserting the no-cookie arm of each handler. A source-scan alternative is available and weaker: enumerate the literals beside each `bySessionToken` call. Neither exists yet. |
| **Priority** | **Should ship.** The behaviour is right and only the wording is wrong, which is the cheapest class of fix and the easiest to leave undone forever. |

> **Recommendation (not decided).** Standardise on a sentence with a remedy, in the register
> `make-karaoke/+server.ts:49` already sets for the cook cap — *"you already have 3 songs cooking — wait
> for one to finish"*. Neither `join first` nor `not joined` names what the guest should do on a phone
> that is already showing a joined-looking screen.

---

### XR-API-03 — A capability refusal is 403, not a 401 telling a joined guest to join

| Field | Content |
|---|---|
| **Statement** | An endpoint distinguishes **unauthenticated** (no session — 401) from **unauthorised** (a real session the policy excludes — 403), and the day any capability narrows, the refusal a joined guest receives names the permission rather than instructing them to join. |
| **Surfaces** | Phone (`/settings` writes both scopes). Operator pages (`delete-media`, the marked future host gate). TV exempt. |
| **Rationale** | The two `can()`-gated endpoints collapse both conditions into one 401 saying `join first`, which is indistinguishable today only because `can()` reduces to "is joined" — so the first narrowing ships a message telling an already-joined guest to do the thing they have done, on the surface with the least room to explain. |
| **Source** | `DERIVED`, and the model is the gate's own stated future. **Model:** `server/auth/capabilities.ts:53-55` is `can(actor, _capability) { return Boolean(actor?.singerId); }` — the capability argument is ignored, so today "unauthenticated" and "unauthorised" are the same predicate and one status is honest. `capabilities.ts:9-12` states the intent to narrow it later ("a host role, an `ENCORE_HOST_TOKEN`, a first-joiner-is-host rule — is an edit HERE and nowhere else"), and the 2026-09-09 rulings recorded in `../ux/05-concurrency.md` keep every capability open *for now*. At the two call sites — `settings/+server.ts:24` and `settings/room/+server.ts:19` — a `false` from `can()` returns `json({ error: 'join first' }, { status: 401 })`, and a narrowed `can()` would route a joined guest into exactly that branch. `delete-media/+server.ts:9` and `:22-23` mark the same trap in a third place, where the joined check is to be swapped for a capability check with the 401 left in place. |
| **Acceptance** | **Given** a request with no session cookie to a `can()`-gated endpoint, **then** the response is 401. **Given** a request with a valid session whose actor the policy excludes, **then** the response is **403** and its text names the permission, not the act of joining. **And given** `can()` narrowed so any capability returns false for a joined singer, **then** no endpoint answers that singer 401. |
| **Check** | A route test constructing both cases against a stubbed `can()`. It **does not exist yet**, and neither does the second case in the product: with today's `can()` there is no input that separates the arms, so the test must inject the narrowed predicate rather than wait for it. `tests/guards/hygiene/capabilities.test.ts` already pins `can()`'s truth table and is the natural sibling. |
| **Priority** | **Should ship** now, **ship-blocking** for whichever capability narrows first — the two decisions are coupled, and doing this second means shipping the wrong message once. |

> **Recommendation (not decided).** Split the two conditions at both call sites now, while they are two
> lines and the second arm is unreachable. The unreachable arm is the point: it is what makes the
> narrowing a one-line edit in `can()` as `capabilities.ts:12` promises, instead of a one-line edit plus
> a hunt through every gate for a 401 that has become a lie.

---

### XR-API-04 — The same fault gets the same status code across endpoints

| Field | Content |
|---|---|
| **Statement** | A given fault class answers one status code everywhere it can occur; in particular "the `mediaId` you named is not a song this box knows" is one code across all three endpoints that can say it. |
| **Surfaces** | Phone (make-karaoke, lyrics-reselect); operator pages (delete-media). TV exempt. |
| **Rationale** | The phone branches on status before it reads a body — a 4xx is a toast, a 429 is a limit with a wait, a 5xx is "the box is unwell" — so the same fault arriving as two different codes makes a correct client impossible to write from the contract alone. |
| **Source** | Cited, and the disagreement is verified in three files. Unknown media is **409** at `make-karaoke/+server.ts:28`, **404** at `lyrics-reselect/+server.ts:19` (the `'unknown-media': 404` entry in `REFUSAL_STATUS`) and **404** at `delete-media/+server.ts:48`. `make-karaoke` additionally answers 409 for four distinct conditions — unknown media (`:28`), a metadata-only source (`:40`), the song is playing (`:43`) and a generic failure to start (`:61`) — so 409 there carries no information a client can act on beyond "not 429". The counter-example is deliberate and good: `lyrics-reselect/+server.ts:16-23` is an explicit fault-to-status table with a comment stating the reasoning, and `delete-media/+server.ts:47` explains its 404 as letting the dashboard tell "already gone" from "done". |
| **Acceptance** | **Given** a `mediaId` no catalog row matches, **when** it is sent to make-karaoke, lyrics-reselect and delete-media, **then** all three answer the same status; **and** any two answering differently falsifies it. **Given** the four `make-karaoke` 409 arms, **then** each carries a distinct `reason` code, or the codes differ. |
| **Check** | A route test driving the unknown-media arm of all three handlers and asserting one status. It **does not exist yet**; `tests/unit/core/routes/api/make-karaoke/not-cookable-arm-742.test.ts` covers one 409 arm of one endpoint and is the closest existing work. |
| **Priority** | **Should ship.** No guest is harmed by this today, because each phone call site was written against the endpoint it calls; the cost lands on the next consumer, and on anyone reading the three files expecting a rule. |

> **Recommendation (not decided).** Adopt `lyrics-reselect`'s table as the pattern and make unknown media
> **404** everywhere — a `mediaId` that names nothing is a missing resource, not a conflict with a state,
> and `make-karaoke` is the one of the three that disagrees. Then give its remaining 409 arms distinct
> `reason` codes, which `:38` and `:50` already show the shape of.

---

## Group B — What a request may say

### XR-API-05 — A body is validated as a whole against a declared shape

| Field | Content |
|---|---|
| **Statement** | Every endpoint that reads a request body validates that body against a **declared** shape before using any of it, and states whether an unrecognised field is rejected or ignored. Per-field inline `typeof` checks at the point of use do not satisfy this. |
| **Surfaces** | Phone (join, me, make-karaoke, lyrics-reselect, both settings writes); operator pages (delete-media). TV exempt. |
| **Rationale** | Validation spread across the point of each field's use has no place to notice what the body contained that no branch read, which is how a request can be accepted, answered 200, and have its payload silently dropped — the defect `XR-API-06` records, and the one class this rule would have caught structurally. |
| **Source** | Cited for the current posture, `UNSOURCED` for the choice of mechanism. Six handlers read a body and no two agree on how. Five use `await request.json().catch(() => ({}))` — `join/+server.ts:10`, `me/+server.ts:33`, `make-karaoke/+server.ts:17`, `delete-media/+server.ts:25`, `lyrics-reselect/+server.ts:36` — which converts malformed JSON into an empty object, so the caller is later told a *field* is missing rather than that the body did not parse. Two use an explicit `try`/`catch` answering `{ error: 'invalid json' }` — `settings/+server.ts:26-31`, `settings/room/+server.ts:29-34`. Fields are then checked one at a time at the point of use (`typeof body.mediaId === 'string'`, `make-karaoke/+server.ts:18`; the same at `delete-media/+server.ts:26` and `lyrics-reselect/+server.ts:37`). No schema validator is a dependency of any package: `zod`, `valibot` and `ajv` appear in no `package.json`. The two settings endpoints are the closest thing to a whole-body contract and get there differently — a shared normalizer re-normalises over current values, so a partial or spoofed body degrades per field rather than being refused (`settings/+server.ts:5-8`, `:33-35`). |
| **Acceptance** | **Given** malformed JSON, **when** sent to each body-reading endpoint, **then** every response says the body did not parse, and none reports a missing field instead. **Given** a body carrying a field no handler reads, **then** the response either refuses it or the endpoint's contract states that unknown fields are ignored. |
| **Check** | Per-endpoint tests asserting the malformed-body arm and the unknown-field arm. **None exists.** A source-scan sibling is also available — assert no handler reaches `body.<field>` before a whole-body validation call — and is the shape this repo already uses widely, for example `tests/guards/wiring/capability-wiring.test.ts`'s arm-scoped slicing. |
| **Priority** | **Should ship.** The normalizers make the *settings* pair genuinely safe already, so this is not a live exposure; it is the structural gap that let `XR-API-06` ship undetected. |

> **Recommendation (not decided).** Do not add a validation library for six handlers on a LAN box. Adopt
> the `settings` pair's shape instead — one exported `parseXBody(unknown)` per endpoint, returning either
> a typed value or a refusal, called once at the top — which makes the whole body a single decision
> without a new dependency, and gives the `Check` above something to scan for.

---

### XR-API-06 — A field the endpoint accepts is used, or the request is refused

| Field | Content |
|---|---|
| **Statement** | No endpoint answers 2xx to a request whose payload it discarded. Where a body field is read and then not carried through to the work it names, the endpoint refuses the request and says why. |
| **Surfaces** | Phone — `routes/+page.svelte` posts the paste to `/api/lyrics-reselect`, and its dialog is `lib/components` work covered by `tests/unit/core/lib/components/lyrics-reselect-640.test.ts`. TV exempt. |
| **Rationale** | A 200 with a job id is the strongest promise this API makes, and a guest who pastes the correct words for a song, receives that promise, and then watches the same wrong lyrics scroll past on the TV has been told by the product that it did the thing it did not do. |
| **Source** | Cited, and verified end to end across three languages. `lyrics-reselect/+server.ts:41` reads `body.text`; `:44` uses it only for a truthiness branch, refusing a whitespace-only paste as `no-text`; `:48-53` then calls `requestLyricsReselect(mediaId, { ref, text }, …)`. Inside it, `server/jobs/make-karaoke.ts:256` computes `pasted` and uses it **only** to select a deterministic ref (`:258-259` → `manualLyricsRef`, `:224-226`), sets `media.lyricsOverrideRef = ref` (`:269`), and enqueues an align job (`:282`) — **the text itself is never written or passed**. `server/jobs/dispatch.ts:108` then sends the worker `pinnedRef` and nothing else. The receiving contract exists and is unfilled: `packages/shared/src/core/events.ts:267-272` declares `pinnedText` as "PASTED lyrics text for a `manual`-source re-pick … the worker times THIS text", `apps/worker/src/steps/lyrics.py:830` reads `ctx.params.get("pinnedText")`, and its docstring at `:815-816` calls that field "The FIRST producer of SOURCE_MANUAL, which `chain.py` has held reserved with no producer since the two-tier split" (`apps/worker/src/lyrics/chain.py:44`) — and **`pinnedText` occurs in exactly one TypeScript file, its own declaration.** No producer exists. The worker therefore falls to its `else` branch (`lyrics.py:834`), reads the manual ref off disk, finds nothing wrote it, returns `None`, and skips the step with the reason at `lyrics.py:252-253` — *"pinned lyrics … carry no readable text — leaving the stored"*. The route has already answered 200 with a job id. |
| **Acceptance** | **Given** a cooked song and a `POST /api/lyrics-reselect` carrying `{ mediaId, text }` with real words, **when** the response is 2xx, **then** those exact words are retrievable as the pinned candidate before the align job is dispatched; **and** a dispatched job whose params carry no `pinnedText` while the request carried `text` falsifies it. **Given** the words cannot be carried, **then** the response is a refusal naming that, not a job id. |
| **Check** | Two guards, both **new**. (1) A route test asserting the paste path either persists the text or refuses — the handler-driving harness at `tests/unit/core/routes/api/room-preview/server.test.ts` is the pattern. (2) A producer-existence scan in the shape of `tests/guards/docs/vocabulary-parity.test.ts`, which exists precisely because the TS↔Python contract is hand-mirrored and drifts silently: assert every field the worker reads from `ctx.params` has at least one TypeScript producer. That second guard generalises the defect instead of pinning this one field, and `vocabulary-parity.test.ts`'s own header calls this class "the single biggest unguarded contract in the repo". |
| **Priority** | **Ship-blocking.** It is the only row here where the product currently makes a false statement to a guest, the feature it breaks is the entire reason `/api/lyrics-reselect` exists, and the failure is invisible on both ends — the phone sees a job, the worker logs a skip. |

> **Recommendation (not decided).** The paste path is unreachable, not merely lossy, so the choice is to
> finish it or to refuse it. Refusing is one line and honest; finishing it is a `pinnedText` on the
> params bag at `dispatch.ts:108`, which needs the text carried on the media or the job — a design
> decision, since `lyricsOverrideRef` is a ref and has nowhere to put words. Do not leave the third
> option in place, which is answering 200.

---

### XR-API-07 — A request body is bounded, and the bound is declared in a tracked file

| Field | Content |
|---|---|
| **Statement** | The maximum accepted request body size is set explicitly in a file under version control, and every endpoint accepting free text declares its own field-level maximum. |
| **Surfaces** | Phone (the lyrics paste is the only free-text field a guest can post). Operator pages exempt — they post ids. TV exempt. |
| **Rationale** | This is a box on a living-room LAN with no rate limit and a joined-singer bar that any phone can clear by calling `/api/join`, so the only thing standing between a guest and an arbitrarily large write is a limit nobody has stated. |
| **Source** | Cited for the absence, `UNSOURCED` for any number. No `svelte.config.*` is tracked — `git ls-files` matches none — so the adapter's own limit is not declared in the repository; the adapter is `svelte-adapter-bun` (`apps/core/package.json:40`) and `apps/core/build/` is generated and untracked, so its contents are not evidence about configuration. The Bun.serve entry that owns every HTTP request (`apps/core/server.ts:183-186`) sets `port`, `hostname` and `idleTimeout: 30` and no body limit; `maxRequestBodySize` appears in no tracked source file. At the field level, the pasted lyrics text is trimmed and never measured (`server/jobs/make-karaoke.ts:256`, `choice.text.trim()`), and `lyrics-reselect/+server.ts:40-45` checks only that it is a non-empty string. **The effective runtime default is `UNSOURCED` here — it was not measured, and the built output is not a tracked declaration.** |
| **Acceptance** | **Given** the repository, **when** a reader looks for the maximum request body size, **then** they find it in a tracked file. **Given** a paste longer than the declared field maximum, **when** posted to `/api/lyrics-reselect`, **then** it is refused with a reason naming the limit rather than truncated or accepted. |
| **Check** | `EXEMPT` for the transport half: the limit is a property of the server the built adapter runs, and asserting it needs a real request against a real listener, which is the `apps/core/e2e/` rung rather than `bun test`. **The judgment deferred is the number** — nothing in the repo or outside it says what a lyrics paste's maximum should be. The field-level half is checkable by a route test asserting the over-length arm, and that test **does not exist yet**. |
| **Priority** | **Should ship.** Reachability is real but the actor must first join, and the worst outcome is a large row on the host's own disk rather than a cross-guest failure — which is why this is not ship-blocking and is also not nothing. |

---

### XR-API-08 — A mutating request is safely retryable, or says it is not

| Field | Content |
|---|---|
| **Statement** | Every state-changing HTTP endpoint either accepts a client-supplied idempotency key and answers a repeat of the same key identically, or documents that a retry is unsafe and what the caller should do instead. |
| **Surfaces** | Phone (join, me, make-karaoke, lyrics-reselect, both settings writes); operator pages (delete-media). TV exempt. |
| **Rationale** | Every one of these requests is made from a phone on domestic Wi-Fi, where a lost response is indistinguishable from a lost request, and the websocket path solved exactly this problem with a ledger while the HTTP path — which carries the destructive operation — did not. |
| **Source** | `DERIVED` by comparison with the websocket seam. **Model:** the queue's op path requires a client op id and refuses a frame without one (`server/realtime/hub.ts:109`, `'missing clientOpId'`), and it is backed by a two-function ledger whose distinction is documented in unusual detail — a record-on-check `seenOp` and a non-recording `hasOp`, with `hub.ts:66-73` and `:287` recording that reading with the recording variant would "turn its resend into a false success". **`clientOpId` occurs nowhere under `routes/api/`.** `delete-media/+server.ts:37-38` makes the asymmetry explicit rather than accidental: it builds hub deps with `seenOp: () => false, hasOp: () => false` and states at `:29-31` that "the idempotency ledger is unused here — a no-op ledger is correct", because the delete drives `applyQueueOp` directly. Two endpoints are already idempotent by construction and should be cited rather than changed: `make-karaoke/+server.ts:70-77` records that `enqueue` "is idempotent and hands back the EXISTING live job when one is in flight", and the settings writes are last-writer-wins patches. Three are not: a repeated `/api/join` creates a second singer or answers 409 on the name; a repeated `/api/delete-media` answers 404 where the first answered 200; a repeated `/api/lyrics-reselect` cancels the align job the first one started (`make-karaoke.ts:279-282`). |
| **Acceptance** | **Given** any state-changing endpoint and a request sent twice with the same idempotency key, **when** both responses are compared, **then** they are identical and the state matches one application; **and** for an endpoint documented as non-retryable, **then** its contract says so and names the caller's remedy. |
| **Check** | A route test replaying each mutating request and comparing responses. **It does not exist yet.** The websocket side's equivalent discipline is worth reading first — `hub.ts:287`'s note that the recording read turns a resend into a false success is the mistake a naive HTTP ledger would repeat. |
| **Priority** | **Should ship**, and the case is `/api/delete-media` alone: it is the destructive endpoint, it is the one that explicitly opted out of the ledger, and a retried hard-delete of a song someone re-added between attempts is the one outcome here that cannot be undone. The rest is tidiness. |

> **Recommendation (not decided).** Do not fit a general idempotency layer to six endpoints. Write the
> contract down — join, delete-media and lyrics-reselect are not safely retryable, make-karaoke and the
> settings writes are — and then give a key to `delete-media` only, where the irreversible act is.

---

## Group C — What an unjoined caller may do and learn

### XR-API-09 — An unauthenticated read performs no durable write

| Field | Content |
|---|---|
| **Statement** | An endpoint reachable without a session performs no durable write, or its write is stated in the endpoint's own contract and in every other document that describes it. |
| **Surfaces** | Phone (search runs on a debounced keystroke); operator pages (library). TV exempt. |
| **Rationale** | "Unauthenticated and read-only" is the sentence that makes leaving an endpoint ungated defensible, and two files in this tree use it about an endpoint that writes — so the reasoning that keeps the surface open is resting on a claim the code does not support. |
| **Source** | Cited, and the contradiction is between files rather than inside one. `GET /api/search` requires no session and writes durably per request: `search/+server.ts:94` calls `app.media.upsert(media)` for every newly materialised hit, and `:89` mutates an existing stored row in place via `refreshDisplayFields` and persists when a display field moved (`:55`, guarded to write only on change). Its own header is honest — "materializes + persists each hit" (`:5`). Two other files are not: `library/+server.ts:7` says "Read-only and unauthenticated, like /api/search", and `stats/+server.ts:3` says "Read-only and unauthenticated, matching /api/library and /api/search". `GET /api/library` additionally re-seeds the runtime catalog (`:34`, `hydrateMediaCatalog`) with a stated reason, which is a process-state write rather than a disk write. `GET /api/stats` and `GET /api/settings` genuinely only read. |
| **Acceptance** | **Given** each endpoint reachable with no session cookie, **when** it is called and the media table is compared before and after, **then** either no row changed, or the endpoint's header and every document describing it say that it writes; **and** a file describing a writing endpoint as read-only falsifies it. |
| **Check** | A doc-accuracy guard in the exact shape this repo already runs: `tests/guards/docs/doc-accuracy.test.ts` exists to catch a header asserting behaviour the code does not deliver, and `tests/guards/docs/spotify-enforcement-prose-742.test.ts` exists because five sites described an enforcement that did not exist — including one that asserted a spotify hit "is not materialised into a queueable media, which /api/search does on every query", i.e. **the same endpoint, the same class of false claim, already guarded once.** A guard for this instance **does not exist yet**. |
| **Priority** | **Should ship.** The write is benign and deliberate; the false description is the defect, and it is load-bearing because it is the premise of leaving the endpoint open. |

---

### XR-API-10 — Work an unjoined caller can cause is bounded

| Field | Content |
|---|---|
| **Statement** | Every endpoint reachable without a session has a stated bound on the work one caller may cause — subprocesses spawned, rows written, disk consumed — including "no bound" as an explicit answer with its reasoning. |
| **Surfaces** | Phone (search, join, room-preview); operator pages (library, stats, metrics). TV exempt. |
| **Rationale** | The joined-singer bar is not a resource control, because `/api/join` is itself unauthenticated, so the only real distinction on this box is between work a caller can cause once and work they can cause in a loop — and nothing currently measures the difference. |
| **Source** | `UNSOURCED` for every number; cited for the mechanism. **Model for the exposure, not for a threshold:** `GET /api/search` fans out to three resolvers per request (`search/+server.ts:73-82`), one of which is yt-dlp — a subprocess — with a per-source limit of 12 (`:15`) and a `safeSearch` wrapper that swallows a dead source (`:19-26`) but bounds nothing about rate; each surviving hit is then persisted (`:94`). `POST /api/join` creates a durable singer row with no cap on how many. `GET /api/room-preview` resolves a code with no attempt limit, over a keyspace of 31 characters to the sixth power (`packages/shared/src/core/room-code.ts:15`, `:18`). The one bound that exists anywhere on the HTTP surface is per-singer and on the expensive axis: `MAX_CONCURRENT_COOKS_PER_SINGER`, answered 429 at `make-karaoke/+server.ts:45-53`. **No rate limiter exists in the tree** — the only occurrences of 429 are that arm and three upstream-status comments in `server/media/spotify.ts` and `server/media/thumbs.ts`. `/api/metrics` names this axis itself (`:3-6`): any phone on the LAN can POST `/api/join`, "so a singer check here would be theatre, not a gate". |
| **Acceptance** | **Given** the contract for each unauthenticated endpoint, **when** a reader asks what one caller can cause in a loop, **then** they find a stated bound or a stated decision not to bound it; **and given** a stated bound of N, **when** a caller exceeds it, **then** the response is 429 with a reason rather than the work being done. |
| **Check** | `EXEMPT` from a source scan — a rate bound is a claim about behaviour over time that no static analysis can make, and the harness that could drive it is `apps/core/e2e/fuzz.mjs` against a real listener rather than `bun test`. **The deferred judgment is whether to bound this at all**, which on a trusted LAN is a legitimate no. |
| **Priority** | **Should ship** as a written decision; **not** ship-blocking as a mechanism. The threat model is a phone on the party's own Wi-Fi, and `capabilities.ts:26-27` already draws the line the product actually cares about — "the difference between a guest and a stranger's script". |

> **Recommendation (not decided).** State "no rate limits, by design, on a trusted LAN" and put the
> reasoning `metrics/+server.ts:3-6` already contains where a reader will find it. Then bound the one
> endpoint whose work is not proportional to the caller — `/api/search`, which spawns a subprocess per
> request — not with a rate limiter but by making the resolver fan-out refuse to run concurrently with
> itself, which needs no policy number.

---

### XR-API-11 — What an ungated endpoint reveals is bounded by what the room can already see

| Field | Content |
|---|---|
| **Statement** | An endpoint reachable without a session discloses nothing a person in the room could not already read off the TV, and where it discloses more, the excess is enumerated and its acceptance is dated and attributed. |
| **Surfaces** | Operator pages (`routes/metrics`, `routes/metrics/[mediaId]` read the two ungated internal endpoints); phone (room-preview). TV — the reference standard, and it fetches nothing. |
| **Rationale** | "Anyone on the LAN can see the room anyway" is the whole argument for having no operator identity, and it holds exactly as far as the shared display goes — worker hostnames, model names and raw error strings are not on the wall, so they need their own decision rather than inheriting that one. |
| **Source** | Cited, including the existing acceptance and its stated limit. `GET /api/metrics` is ungated and says so at `:3-6`, and — unusually — enumerates its own exposure at `:8-10`: "worker ids, model and backend names, host details, and terminal error strings. No singer identities and no media bytes", with the remedy named ("Bind the server to a trusted interface, or add a token"). `GET /api/audit/[mediaId]` is ungated for the same reason and says it "exposes the same class of internal detail (worker ids, model names, error strings) for one song" (`audit/[mediaId]/+server.ts:7-8`); its response carries `workerId`, `error`, `engine`, `model`, `backend` and `device` per attempt (`audit/[mediaId]/audit-shape.ts:20-27`). `GET /api/settings` has **no session check at all** (`settings/+server.ts:16-19`) and returns the effective deployment configuration. Two ungated endpoints are within the TV's own bound and should be recorded as such rather than flagged: `GET /api/room-preview` returns present-guest display names, and its header argues the case explicitly — `/tv` "already renders the present singers BY NAME on the big screen"; and `GET /api/stats` is aggregate with no singer column to expose (`stats/+server.ts:3-5`). What is missing is not the reasoning — `/api/metrics` has the best-reasoned comment on this surface — but a dated owner acceptance outside a source comment, which is the gap the concurrency section's published-rulings table closed for capabilities. |
| **Acceptance** | **Given** each endpoint reachable with no session, **when** its response is compared against what the TV renders, **then** every field beyond that set appears in a published, dated acceptance; **and** an ungated endpoint disclosing a worker hostname with no such acceptance falsifies it. |
| **Check** | A source-scan asserting every ungated handler under `routes/api/**` is named in this document's acceptance list — the enumeration shape `tests/guards/hygiene/page-header.test.ts` already proves works here, and the same shape `../ux/05-concurrency.md`'s `XR-CON-06` uses to keep `can()` and its policy document detectably in sync. **It does not exist yet.** |
| **Priority** | **Should ship.** The exposure is real and already reasoned about; what is absent is the record, and on a self-hosted box the record is what lets an operator who did not read the source decide whether to bind to a trusted interface. |

> **Recommendation (not decided).** Ratify all three as open, and move the acceptance out of the source
> comments into this document with a date and an owner — the content already exists at
> `metrics/+server.ts:3-10` and needs relocating, not authoring. Then close the one asymmetry that is
> not reasoned anywhere: `PUT /api/settings` is gated while `GET /api/settings` reads the same
> deployment configuration with no check, and no comment in either file says that was decided.

---

## Group D — Verification

### XR-API-12 — Every route's auth posture is pinned by a guard scoped to that route

| Field | Content |
|---|---|
| **Statement** | Every handler under `routes/api/**` has its auth posture — ungated, session-required, or capability-gated — asserted by a test scoped to **that handler**, so deleting a gate fails a test that names the route. Named exemptions: none; an ungated route is pinned as deliberately ungated. |
| **Surfaces** | None (project artefact). Governs the evidence for every row above. |
| **Rationale** | Sixteen route files carry eleven auth decisions between them and not one is asserted anywhere, so every gate on this surface is currently protected by nothing but the next reader noticing — and the same promise was already found false twice on the websocket side, which is why the guard that exists there exists. |
| **Source** | `DERIVED` by enumeration against this branch. **Model:** the gates are (a) eight direct `bySessionToken` session checks — `leave/+server.ts:15` and `:24`, `me/+server.ts:18` and `:28`, `make-karaoke/+server.ts:14`, `delete-media/+server.ts:22`, `lyrics-reselect/+server.ts:33`, plus `join`'s cookie issue; (b) two `can()` capability gates — `settings/+server.ts:24`, `settings/room/+server.ts:19`; and (c) six deliberately ungated handlers — search, library, stats, metrics, audit, thumb, room-preview and `GET /api/settings`. `tests/guards/wiring/capability-wiring.test.ts` is the guard for this class and reads `hub.ts` only — it contains no occurrence of `settings`, `routes/api` or any route path — so **both HTTP `can()` call sites are unguarded**, which `../ux/05-concurrency.md`'s `XR-CON-07` also records from the capability side. No test under `tests/unit/core/routes/api/` asserts a status code or a gate; the nine that exist assert computation. |
| **Acceptance** | **Given** each handler, **when** its auth gate is deleted, inverted, or replaced with a gate for a different condition, **then** a test fails naming that route. **Given** a new file added under `routes/api/`, **then** a test fails until its posture is declared. |
| **Check** | Extend `tests/guards/wiring/capability-wiring.test.ts` to the two HTTP `can()` sites using the arm-slicing it already does for `hub.ts`, and add a **new** route-posture guard driven off the filesystem — enumerate `routes/api/**/+server.ts`, and require each exported handler to appear in a declared posture list. Driving it off the directory rather than a hand-written list is the load-bearing part: `tests/guards/meta/non-vacuity-floors.test.ts` exists because roughly two dozen guards here derive their own scope and then assert an array is empty, which is what a working guard and a guard examining nothing both produce. |
| **Priority** | **Ship-blocking**, and it is the row the rest of this section depends on: `XR-API-03` narrows a gate, `XR-API-11` ratifies six routes as ungated, and neither holds without something that fails when a gate moves. |

> The mutation discipline matters here as much as on the concurrency side: the evidence is **"I deleted
> one route's gate and exactly one test reds, naming that route"**, reported as two numbers. A guard that
> reds for every route when one gate is deleted has matched the whole tree and pinned nothing.

---

## (a) Requirements deliberately NOT written, and why

1. **An SSRF allowlist for `/api/thumb`.** Already stated *and* enforced —
   `server/media/thumbs.ts:12-33` is https-only over a five-host allowlist, names the cloud-metadata
   attack in its comment, and is covered by `tests/unit/core/server/media/thumbs.test.ts`. It also
   carries the only bounded upstream fetch on this surface (`:55`). Writing a row would restate the one
   thing here that was never at risk.
2. **A session-cookie attributes requirement.** Enforced and guarded:
   `tests/guards/hygiene/session-cookie-attributes.test.ts` exists, and `join/+server.ts:24-27` records
   the real defect it defends against — `Secure` derived from `url.protocol` marked the cookie Secure on
   a plain-HTTP LAN, the phone discarded it, and `/api/me` then 401'd with no cookie to read.
   `server/public-origin.ts` is the fix and has its own test.
3. **Room-scoping of HTTP reads.** `server/realtime/room-scope.ts` already centralises tenancy, and
   `me/+server.ts:20-22` and `join/+server.ts:31-36` both record why the session token *is* the scope
   token and why a room may not be read from a client-supplied value. Stated, enforced, and better
   argued than a new row.
4. **The authority policy for any capability.** Ruled 2026-09-09 and published in
   `../ux/05-concurrency.md` § "Owner rulings". `XR-API-03` deliberately takes only the **HTTP
   expression** of a refusal, which those rulings do not address.
5. **A `days`/`limit` clamping requirement.** `clampDays` is shared, both callers pass an explicit
   `max` (`stats/+server.ts:20`, `metrics/+server.ts:21`), `clampLimit` backstops the row count
   (`metrics/+server.ts:93-97`), and `tests/unit/core/routes/api/days-clamp.test.ts` covers it. The
   related and more interesting property — that a truncated sample says so — is also already built
   (`metrics/+server.ts:46`, `clipped`).
6. **A latency or timeout budget per endpoint.** No source prescribes one for a LAN box, and inventing
   a number would present a choice as a finding. The one place a bound genuinely exists is the thumbnail
   proxy's 5 s upstream timeout, which item 1 covers.
7. **CORS, CSRF or an origin check.** SvelteKit applies its own same-origin protection to form actions
   and these are JSON endpoints on a same-origin phone client, so the question is what a *non-browser*
   caller on the LAN may do — which is `XR-API-10` and `XR-API-11`, not a header rule. Recorded so the
   next reader does not add a row for symmetry with a public web service.
8. **A versioning or deprecation rule for the surface.** The client and server ship as one artefact
   from one repository and there is no third-party consumer, so a version negotiation would protect
   against a mismatch that cannot occur. Worth revisiting the day anything but this app's own pages
   calls these endpoints.
9. **`GET /api/leave`'s existence as a cost preview.** Already the best-documented endpoint in the tree
   (`leave/+server.ts:1-6`: there is no undo, so the confirm is the only place the cost can be stated)
   and already guarded by `tests/guards/docs/doc-accuracy.test.ts`, which exists because that same
   header once documented a `leave/preview` route that never existed.
