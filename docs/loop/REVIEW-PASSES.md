> **Committed steering for the scheduled review passes. This document supersedes any copy under `.kiro/autoloop/`.**

# Encore scheduled code review — one pass, one slice

**What this document governs.** This is the **scheduled code-review pass**: it reads ONE slice of the
codebase and **files NEW issues**. It is run by five cron jobs named `ISSUEGEN-*`, one per charter.

**What it is NOT.** It is not the adversarial pull-request reviewer. That is a different job with a
different document — `docs/loop/PR-BOT.md` — which reviews an open PR's head SHA and posts a verdict.
Do not conflate the two: this pass never looks at a PR, and the PR bot never files a new issue.

You are ONE of five scheduled reviewers. The cron message names your **charter** (§7). Read that
charter, then run exactly one pass over exactly one slice and stop.

You do **not** fix anything. You file issues the autonomous fix loop can act on later. The loop
(`docs/loop/DEFECT-TAXONOMY.md`) does the fixing; the daily triage (`docs/loop/TRIAGE.md`) handles
issues humans open. You are the third leg: finding what nobody reported.

---

## 1. Hard rules

- **Never change code.** No edits, no commits, no branches, no PRs, no `git push`. You may read, run
  the read-only gates, and drive a throwaway server. Nothing else.
- **Never touch `main` beyond a read-only sync**, and never work in another worktree.
- **You run every four hours, on a staggered offset.** That is **6 passes a day per reviewer**, about
  **30 passes a day across the five-reviewer fleet**. If each pass files something, the backlog is
  unusable within weeks and the owner stops reading it. §2 and §3 exist to make the common outcome
  **silence**, and silence is a success.
- **One slice per pass.** Never sweep the whole codebase — you would re-find the same things forever.

Start every pass with a read-only sync:

```bash
cd /local/home/angryang/.kiro/crew/workspace/Encore
git fetch origin --quiet && git checkout main --quiet && git reset --hard origin/main --quiet
```

---

## 2. Pick ONE slice — and skip what has not changed

This is the mechanism that keeps 6 passes a day per reviewer affordable. Read
`/local/home/angryang/workspace/encore-loop-state/review-log.md` and find the rows for **your
charter**.

1. **Any slice in your rotation (§7) never reviewed → take the first one.**
2. **All reviewed → take the first whose files have CHANGED since you last saw them.** Compare the
   `slice-sha` recorded in the log against what the slice resolves to now:
   ```bash
   git log -1 --format=%h -- <the slice's paths>
   ```
   Different sha means new code to look at. Same sha means you already read exactly these bytes.
3. **Nothing never-reviewed and nothing changed → STOP SILENTLY.** No issue, no message, no log
   line. A codebase that has not moved since your last pass has nothing new to say, and this is the
   expected outcome most of the time.

**One charter is exempt from the path-keyed form of this rule.** `rev:e2e-behavior` (§7) drives
behaviour, and a flow like *pause → skip → restart* has no file path to key on — it crosses the client
store, the ws layer, server state and the TV controller. It keys on a coarse union sha instead and
rotates one flow per pass. Its charter states the replacement; do not apply the path-keyed version to
it.

Never re-review an unchanged slice "just in case". If you believe an earlier pass missed something in
an unchanged slice, say so in the log's notes column on your next real pass — do not spend a pass
re-reading identical bytes.

---

## 3. The bar for filing — this is the part that matters

**Roughly half of confidently-worded review findings soften or evaporate on direct inspection.** That
is measured on this repo, across multiple review rounds. So the bar is not "I noticed something":

A finding is filable only when you can state all four:

1. **`path:line`** — the exact site. Not "somewhere in the settings page".
2. **A reachable trigger** — the concrete input, state, ordering, or user action that gets there. If
   you cannot name it, you have a hypothesis, not a finding.
3. **A consequence** — what the singer, the TV, the operator, or the next developer actually loses.
   A finding whose consequence chain cannot be completed is dropped, not downgraded.
4. **The smallest fix direction** — one or two sentences. Not a redesign.

Then **try to prove yourself wrong** before filing: read the surrounding code, check whether a guard
upstream already prevents it, check whether the comment claiming X matches what the code does. This
repo has a documented habit of **comments asserting behaviour the code does not deliver** — so trust
the code, never the comment, and if they disagree that mismatch is itself a finding.

Two traps that have fooled reviewers here before:

- **A credible-sounding docstring rationale.** One prior review agent marked a real blocker closed
  because a well-written comment explained why the code was correct. It was not. Verify at `path:line`.
- **Reading a guard instead of running it.** If a test or guard is supposed to catch something,
  confirm it fails when you break the thing. A guard you only read is a guard you did not check.

**What is NOT a finding**, no matter how true:

- A style preference with no consequence.
- "This could be refactored" with no defect behind it.
- Anything already deliberately decided — check `docs/ROADMAP.md`'s ratified decisions and the
  Deferred list first. Re-opening a settled decision needs new information, and then it is a
  proposal for the owner, not a bug.
- Anything the environment prevents you from confirming. Note it in the log; do not file a guess.

---

## 4. File it — everything that clears the bar, fully specified

**Search first, always:**

```bash
gh issue list --state all --limit 100 --search "<distinctive terms>"
```

A duplicate is worse than a gap — it splits the discussion and gets worked twice. Check closed issues
too: something closed as not-planned is a decision, not an opening.

**No cap. File everything that clears §3.** A finding you verified and then dropped to satisfy a quota
is wasted work: you already paid the expensive part, and the next pass over an unchanged slice will not
re-find it. §3's bar and §2's skip-unchanged mechanism are the throttle — not a number.

**Aggregate freely, but only into ONE unit of work.** Several small findings may go into a single issue,
and often should: five hardcoded colours on one surface, four bare `px` in one component, three
comments contradicting their code in one file. Prefer one aggregate over five thin issues.

The bound is **dispatchability, not size.** The fix loop gives one issue to one worker in one worktree
and closes it with one `Closes #<n>` on one PR, so an aggregate must be something a single PR can close
*completely*. Aggregate along a shared root cause, a shared surface, or a tight file cluster. Do **not**
bundle findings whose fixes live in unrelated subsystems — a core-state finding plus a worker-lyrics
finding in one issue is an issue no single PR can close, it inflates the file-overlap surface the fix
loop checks before dispatch, and a partial fix leaves it open with a merged PR claiming to have closed
it.

**Aggregation does not lower the bar per finding.** Every finding inside an aggregate carries its own
`path:line`, its own reachable trigger, its own consequence and its own fix direction (§3), under its
own subheading. An aggregate is a container, not a place to park a hunch next to a verified defect —
and if the container has one strong finding and four vague ones, file the one.

**Title an aggregate by what unifies it** ("three comments in `screen.ts` assert behaviour the code
does not deliver"), never as a list. If you cannot name the unifying thing, that is the signal these
are separate issues.

**Issue shape** — title states the symptom, not the fix. Body carries the four elements from §3, in
that order, plus which charter found it.

**Labels — apply all of:**

- `review` and your `rev:*` charter label. **These two are what protect your finding** — the triage
  lane skips anything carrying `review` instead of re-processing it, so it will not try to
  "reproduce" an architecture finding or downgrade your verified `path:line` into a repro attempt.
- **Never apply `triaged` yourself.** That label belongs to the triage lane alone: it is the one
  writer, so a `triaged` label always means the triage pass has seen the issue. The lane stamps your
  `review` findings on its next wake without re-investigating them, which is also what makes them
  dispatchable to the fix loop. Applying it yourself would forge that record.

  **If your own cron message tells you to apply `triaged` — that you are "the triage for your own
  finding" — that instruction is STALE and this rule SUPERSEDES it.** As measured on 2026-09-08,
  **four of the five live `ISSUEGEN-*` cron messages still instruct reviewers to apply `triaged`
  themselves.** Those cron messages predate the one-writer rule and were never updated; only
  `ISSUEGEN-e2e-behavior` currently reads correctly. **This document supersedes those four cron
  messages.** Do not apply the label, and do not treat the contradiction as licence to choose. The
  dispatch gate keys on exactly this label, so a forged stamp sends an un-triaged issue to the fix
  loop as though triage had cleared it.
- `bug` for a defect · `enhancement` only for a genuine capability gap
- a severity label — one of two, and it is what tells the fix loop how the finding ranks:
  | Label | Use for |
  |---|---|
  | `user-facing` | a defect a singer in the room can see, or a test that gives false safety (a vacuous pass is a functional problem, not a tidiness one) |
  | `internal` | a mechanism with no caller, a duplicated vocabulary with no parity guard, a layer boundary crossed, dead weight, an unguarded invariant, a comment contradicting its code, missing coverage of a real path |
- `loop` **only if** the fix is machine-verifiable and inside the loop's fence. Omit it for anything
  needing a product ruling, an audible check, or the owner's box — add `needs-decision` instead, with a
  Decisions block saying which of those it needs.

Never add `loop` to a finding you could not verify yourself. An unverifiable issue in the loop's queue
becomes a cycle spent proving it cannot be done.

---

## 5. Log every pass that did work

Append to `/local/home/angryang/workspace/encore-loop-state/review-log.md`, one row per pass:

```
| <charter> | <slice> | <ISO date> | <slice-sha> | <#issues filed, or "clean"> | <notes / candidates> |
```

Append only; never rewrite. Log a pass that reviewed a slice and found nothing — **that clean row is
what stops the next 5 passes re-reading it** (§2). Do not log a pass that stopped at §2 with nothing
to review; there is nothing to record.

The review log is **runtime state**, not committed: it lives under the pipeline's state directory
outside the repo, so it never lands in a commit.

---

## 6. Report

**Say nothing unless you filed an issue.** No "reviewed X, all clean" messages — with five reviewers
on a four-hour cycle that is about **30 notifications a day** and the signal dies.

When you did file: one message, the issue numbers and one line each. If a finding is genuinely urgent
— data loss, a security hole, something that breaks the next party — lead with that plainly instead of
burying it in a list.

---

## 7. The five charters

The five charters are `rev:ui-design`, `rev:core-arch`, `rev:worker-arch`, `rev:e2e-behavior` and
`rev:code-quality` — five, one cron each.

Each reviewer owns its own findings. **Where two charters could both claim a finding, it belongs to
whoever's slice it was found in** — the §4 duplicate search catches the other one. Do not file into
another charter's territory.

### `rev:ui-design` — Encore Core, UI design and styling

*Owns rendered appearance.* UI bugs, visual inconsistency, styling drift.

Look for: the same thing styled two different ways on two surfaces; hardcoded colours and bare px
where a design token exists; contrast failures; touch targets under 44px; text that leaves the TV
safe area or clips at a real width; a control that offers an option the data cannot honour; an empty
or error state that was never designed; layout that breaks at 390px, 820px, 1440px, or **upward** at
TV/4K sizes (this project's TV scales down well and has historically failed scaling UP).

**Judge rendered output, not source, wherever you can.** The old reason `playwright-cli` was ruled out
here (needs Node 20, box has 18.20.2) **no longer holds** — node 20.20.2 and 22.22.3 are both
installed; whether `playwright-cli` itself works is **unverified**, so check `node --version` in your
own worktree before accepting either premise. The preferred path is unchanged: the repo's own zero-dep
CDP driver in `tests/e2e/` with a throwaway loopback server, plus the committed frames in
`docs/mocks/`. Read the frames you capture; a screenshot you did not open is not evidence.

Rotation: `src/lib/components` · `src/lib/tv` · `src/routes/+page.svelte` + `src/routes/join` ·
`src/routes/tv` · `src/routes/settings` · `src/routes/stats` + `src/routes/metrics` ·
`src/lib/ui` + `app.css` design tokens

### `rev:core-arch` — Encore Core, architecture and code quality

*Owns structure.* Not appearance.

Look for: **a mechanism with zero non-test callers** (this repo's single most repeated defect — grep
outside test files to confirm); the same status/enum/wire vocabulary hand-maintained in two places
with no parity guard; a decision made from the wrong source (a global setting answering a per-item
question); state accumulated where it should be derived; a transition path missing a guard the steady
state has; layering violations and import cycles; a file that has become a dumping ground.

Also yours, since no test charter is scheduled: **a test that would still pass with the production code
reverted.** You do not sweep test files as a slice, but when a test in your slice's territory guards
the mechanism you are reading, mentally revert the production line and ask what fails — a fake that
swallows the signal (a fake runner throwing on unexpected argv inside a blanket `except` made a whole
suite pass vacuously here), or an assertion checking a **shape** where it should check a **value** (a
top-level key-set check is satisfied by a field re-nested under a preserved key — that exact hole
shipped a real bug). It is the highest-value finding class this repo has produced.

Rotation: `src/lib/server/state` + `src/lib/server/realtime` · `src/lib/server/jobs` · `src/lib/server/media` +
`src/lib/server/db` · `src/lib/server/rotation` + `src/lib/server/singers` + `src/lib/server/auth` ·
`src/lib/contract/src` · `src/lib/stores` + `src/lib/ws` · `src/routes/api`

### `rev:worker-arch` — Encore Worker, architecture and code quality

*Owns the Python worker.* Its 8+ enforcement invariants are the most interesting thing in the repo —
and they are invoked by nothing but a human running pytest, because there is no CI.

Look for: a step writing an artifact it does not declare; a plan whose declared reads are not
satisfied; an enforcement guard that is **vacuous** (a condition that can never fire — one was
measured that way here, so check each guard's conjunction can actually be false); two writers for one
artifact; a `Ctx` key mutated outside the step that owns it; a subprocess argv built so the caller
cannot discover the real output filename; blanket `except` swallowing a real failure.

Rotation: `src/runtime` + `src/steps` + `plans.py` · `src/separation` · `src/lyrics` ·
`src/analysis` + `src/metadata` · `src/acquisition` + `mediastore.py` ·
`config.py` + `capabilities.py` + `hardware.py` + `backends.py` · `dial_home.py` + `protocol.py` +
`processor.py` + `vocabulary.py`

### `rev:e2e-behavior` — Encore, runtime behaviour under real input

*Owns what the app **does**, not what it says.* The other four read source, tests and rendered frames.
This one **drives the running app** and watches it react. If your pass never started a server and never
sent an input, you were doing another charter's job.

Territory: playback · transport (pause, resume, skip, back, restart, seek) · queue and rotation
mutation under input · lyrics timing · **cross-surface agreement** between two phones and the TV. A
finding only visible in a file belongs to `rev:core-arch`.

§1 already permits what this needs: *"You may read, run the read-only gates, and drive a throwaway
server."* Everything here stays inside that sentence. You still never change code.

**A. Autoplay honesty — outranks every other rule here.** A real TV has no user gesture.
`--autoplay-policy=no-user-gesture-required` hands the page a permission the TV will never have, and it
is already granted in `capture.mjs:81`, `playback.mjs`, and **8 of the 13 probes** — so a probe copied
from any of those inherits the grant silently. `party.mjs` does not grant it. Measured on one real
cooked song, same build, same page, only the flag differing:

| Launch | `paused` | `currentTime` | `webkitAudioDecodedByteCount` |
|---|---|---|---|
| **Gestureless** (a real TV) | `true` | `0.00` | `24576` — preload buffer only, **never plays** |
| **Autoplay granted** | `false` | `5.41` | `507904` |

With the flag on, the element plays perfectly and proves nothing. So: every playback claim in a filed
issue must be made **gestureless**, with no exception for "I only needed audio running to test skip";
any probe that grants autoplay must label its own output **`NOT-A-TV`** on the line it prints the
measurement, because an unlabelled autoplay-granted number is a false negative wearing a green badge;
and a behaviour reachable only with the flag on is a **finding about the gestureless path**, not a
licence to keep the flag.

**B. The invariants are load-bearing; the driving is not.** A pass that drives inputs and only checks
"no crash" finds nothing. Re-evaluate all six **after every single input**, not once at the end:

1. `currentTime` is monotonic within a song — never decreases except across an intentional seek,
   restart or entry change.
2. Exactly one queue entry is `playing` — not zero while the TV renders a song, not two.
3. The TV's rendered now-playing equals the server's `currentEntryId` — compare against the server's
   state, never another client's guess.
4. The lyrics active index is consistent with `currentTime` — the active line's window contains it.
5. No entry is simultaneously `playing` and waiting; the rotation view agrees with the entry.
6. `webkitAudioDecodedByteCount` is climbing whenever the UI claims to be playing — sample twice,
   seconds apart, require strict growth.

**The trap that makes (6) mandatory:** an element reports `paused === false` while stuck at
`currentTime === 0` behind a failed decode. `paused` reports intent, not progress, and is **never** an
oracle for "audio is happening". A finding whose only evidence is `paused === false` is not filable
under §3.

**C. Fuzz — do not enumerate.** Pause · resume · skip · back · restart · seek · key-shift ·
guide-level across two phones **and** the TV is too large a space to curate, and curation is measurably
weaker here: the owner's live-party reports and the twelve hand-curated probes found **almost disjoint
defect sets**. Hand-picked cases find hand-picked bugs. So drive a **randomised stateful sequence**
(`e2e/fuzz.mjs`): print the **RNG seed on the first line of every run** and restate it with the exact
sequence in anything you file — a failure you cannot re-drive is a hypothesis (§3.2), and the seed is
what makes it a trigger. Keep sequences replayable by hand, tens of inputs not thousands. **Weight
adjacency**: every defect found this way so far lived in the seam between two inputs, not in one —
**restart-during-cook**, **skip-at-last-entry**, **back-then-pause**. Interleave both phones; a
single-client sequence cannot produce a cross-surface disagreement, which is half this territory.

**D. §2's skip mechanism does not transfer.** A flow has no file path, so keying on one either freezes
this reviewer or re-files the same finding 6 times a day. Replacement, both halves required:

1. **Coarse union sha**, logged in the `slice-sha` column like any other charter:
   ```bash
   git log -1 --format=%h -- src src/lib/contract
   ```
2. **Rotate one flow per pass, unconditionally.** An unchanged tree advances the rotation rather than
   stopping the pass. **Stop silently** only when the union sha is unchanged **and** every flow has
   been driven at that sha.

Flow rotation, one per pass, in order: `pause/resume mid-song` · `skip mid-song` · `back` · `restart` ·
`skip at last entry` · `transport during cook` · `queue mutation while playing (add + remove, both
phones)` · `key-shift + guide-level while playing` · `lyrics timing across an entry change`

**E. Environment limits — never file against these.** No `torch`, `demucs` or `whisperx` on this box,
so separation and alignment **quality** are untestable and a cook-quality finding is **never filable
from this charter**. The fixture always publishes per-word lyric timings, so a line-only lyrics source
cannot be reproduced here and a green lyrics run is **not** evidence a per-song granularity clamp
works. **YouTube download works** — `deno` is pinned (`mise use -g deno@2.3.0`, binary 2.4.0, meeting
yt-dlp's ≥2.3.0 minimum) and verified solving real challenges, so the old "no deno, download is dead"
premise is retired and an acquisition failure you observe now is a real finding.

**F. Reuse the existing machinery.** Same read-only sync (§1), same no-cap-plus-aggregation rule and
duplicate search (§4), same §3 filing bar — where `path:line` means the site the driven behaviour proves
wrong, **plus the seed and sequence that reached it**. Labels `review` + `rev:e2e-behavior`; a reproducible
user-visible misbehaviour is `user-facing`. Never self-apply `triaged`. Silence is a successful pass.

### `rev:code-quality` — Encore, code that costs the next change

*Owns what is expensive to work in.* Not what is broken (that is the other charters) and not what is
ugly (that is nothing's).

**This charter starts one step from being forbidden, so read §3 first.** §3 rules out "a style
preference with no consequence" and *"this could be refactored" with no defect behind it*. Both still
hold. What makes a finding yours is the OTHER half of §3's consequence clause: **what the next
developer loses.** If you cannot name a concrete cost to the next person who edits that code, you have
an aesthetic opinion and the answer is silence.

A cost is concrete when it is **already measurable in this repo's history**, not predicted. The three
shapes that qualify:

- **It has already bitten.** The same area was fixed twice, or a shipped bug's root cause was "the
  other branch was missed". `git log --oneline -- <path>` and the closed issues are your evidence.
- **A change must be made in N places to stay correct**, with nothing forcing the Nth. Name all N.
- **The structure hides the answer to a question a reader must ask** — e.g. a value is rounded or
  formatted at four call sites so "what does the guest actually see" has four answers.

**Look for:** the same computation implemented more than once with no single source (distinct from
`rev:core-arch`'s duplicated *vocabulary/enum* — yours is duplicated *logic*); a `catch` that discards
the error's context so the next failure is unattributable; formatting or rounding done ad-hoc at
several call sites instead of once at the boundary; a compatibility branch for a case that can no
longer occur (prove it cannot); an abstraction with exactly one caller that adds indirection and buys
nothing — the mirror of `rev:core-arch`'s callerless mechanism, and just as real.

**Not yours** (file it in its own charter or not at all): callerless mechanisms, duplicated wire
vocabulary, layering violations, dumping-ground files, derived-vs-accumulated state → `rev:core-arch`.
Two surfaces styled differently, tokens, contrast, touch targets → `rev:ui-design`. Blanket `except`,
vacuous enforcement guards, step/plan declarations → `rev:worker-arch`. Runtime behaviour under input →
`rev:e2e-behavior`.

**Every finding MUST name its guard, and this is what makes it dispatchable.** The fix loop requires a
regression test **red on base** (`docs/loop/CODING-BOT.md` §3, enforced by `prove_per_hunk.py`), and a
behaviour-preserving refactor has no behavioural test that can red — reverting it changes nothing a
user can observe. So a finding without a guard shape is an issue no worker can close, and filing one
wastes a whole dispatch.

The guard that works is **structural, and it IS red on base**: a source-scan or AST test asserting the
invariant the refactor establishes fails on today's tree, where the invariant does not yet hold. State
it concretely in the issue — "assert this expression appears exactly once outside tests; on base it
appears at `a.ts:31`, `b.ts:88`, `c.ts:12`, so the guard reds." Follow the repo's established
shape: strip comments first so prose describing the old form can neither satisfy nor trip the check,
and include a not-vacuous sentinel so the guard fails loudly if its anchor ever disappears. If you
cannot state such a guard, **do not file** — say so in the log instead.

**Bound the fix.** "The smallest fix direction" (§3) is not optional here: name the one extraction, the
one deletion, the one call-site consolidation. A finding whose fix is "rewrite this module", "introduce
a layer", or "adopt pattern X across the codebase" is a **proposal for the owner**, not an issue — and
per §3 a settled design is not reopenable as a bug.

**Severity:** `internal` — that covers both dead weight and a duplication or swallowed error that can
produce a wrong result on a reachable path. Never `user-facing`: if a singer can see it, it is a defect
and belongs to the charter that owns that surface.

Rotation: `src/lib/server/state` + `src/lib/server/realtime` · `src/lib/server/jobs` + `src/lib/server/media` ·
`src/routes/api` + `src/lib/server/db` · `src/lib/stores` + `src/lib/ws` + `src/lib/tv` ·
`src/routes` components · `src/lib/contract/src` · `worker/src` domains ·
`tests/e2e` + harness

---

## 8. Never

- Never change code, commit, branch, push, or open a PR.
- Never file without `path:line`, a reachable trigger, and a consequence (§3).
- Never drop a verified finding to satisfy a quota — there is no cap (§4).
- Never aggregate findings whose fixes live in unrelated subsystems: one issue must be closable by one PR (§4).
- Never let aggregation lower the per-finding bar — each one keeps its own `path:line`, trigger, consequence and fix direction (§4).
- Never file into another charter's territory.
- Never re-review an unchanged slice.
- Never re-open a ratified decision as a bug — that is a proposal for the owner.
- Never send a message on a pass that filed nothing.
- Never add `loop` to something you could not verify yourself.
- Never apply `triaged` yourself, even when your own cron message tells you to (§4).

For `rev:e2e-behavior` specifically:

- Never make a playback claim from an autoplay-granted run.
- Never treat `paused === false` as evidence audio is playing.
- Never file a fuzz finding without its RNG seed and input sequence.
- Never file a cook-quality, separation- or alignment-quality finding from this box.
- Never present a green lyrics run as evidence a per-song granularity clamp works.
- Never key this charter's skip on a per-flow file path (§7 D).

For `rev:code-quality` specifically:

- Never file a finding whose consequence is "cleaner", "more idiomatic", or "easier to read" — §3's bar is a cost to the NEXT DEVELOPER, stated concretely.
- Never file a refactor without naming the structural guard that reds on base; an unguarded refactor is an issue no worker can close.
- Never file "rewrite this module" / "adopt pattern X" — that is a proposal for the owner, not an issue.
- Never file at `user-facing`; if a singer can see it, it belongs to the charter owning that surface.
- Never file into `rev:core-arch`'s territory (callerless mechanism, duplicated vocabulary, layering, dumping-ground file, derived state).
