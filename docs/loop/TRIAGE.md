# Triage lane — migration stage 1

Brief: `.kiro/autoloop/TRIAGE.md` · Log: `.kiro/autoloop/TRIAGE-LOG.md`

Triage is the first lane to move to webhooks. It is the right one to go first for two reasons: it
writes only labels and comments, so it cannot break `main`; and it carries the most-felt friction in
the whole loop — answering a triage question currently requires a label edit on top of the answer.

## Charter

Look at an issue, work out what it is, label it, and say something useful about it. Triage does not
write code. When it needs something from the owner, it asks in a structured block and applies
`needs-decision`.

It is also the **single writer** of the `triaged` label. That is what makes the label trustworthy: a
`triaged` label always means a triage pass actually looked. ISSUEGEN findings arrive pre-labelled
with `review` and are *stamped* on the next pass rather than re-investigated.

## Today

**Trigger:** cron `TRIAGE-IssueTriager` (id `3ba751b0`), every **900s**.

**Work discovery** — two `gh` queries, run read-only against a freshly reset `main`:

```bash
cd /local/home/angryang/.kiro/crew/workspace/Encore
git fetch origin --quiet && git checkout main --quiet && git reset --hard origin/main --quiet

# (a) reviewer findings awaiting a stamp
gh issue list --state open --limit 100 --label review --json number,labels \
  --jq '[.[] | select((.labels|map(.name)|index("triaged")) == null)] | .[] | "#\(.number)"'

# (b) genuinely untriaged issues — never reviewer findings
gh issue list --state open --limit 100 --json number,title,labels,author,createdAt \
  --jq '[.[] | select((.labels|map(.name)|index("triaged")) == null)
             | select((.labels|map(.name)|index("review")) == null)] | .[] | "#\(.number) \(.title)"'
```

The selection rule, in the brief's own words:

> **The `triaged` label is the switch. An issue without it gets looked at, full stop.**
>
> There is no second condition. […] **Removing `triaged` is how the owner asks for a re-triage**, and
> it has to work every time or it is not a lever.

## The Decisions block

Every comment that needs anything from the owner ends with this block, and nothing follows it. If
nothing is needed, the block is omitted entirely — never written as "none".

```markdown
## Decisions to be made

**Q1. <the question, in one plain sentence a non-expert can answer>**
- **A.** <option> — <what it costs or gives up, one clause>
- **B.** <option> — <what it costs or gives up, one clause>
- **C.** <option> — <what it costs or gives up, one clause>
```

The rules that make it work:

- Number questions `Q1`, `Q2`, `Q3`; letter options `A`, `B`, `C` — **as many as genuinely exist**.
  Do not pad to three and do not squeeze five into two.
- One sentence per question, in plain terms. No `path:line` inside the question — the evidence lives
  above the block.
- **Every option names its cost.** An option list with one obviously-right choice is not a decision;
  make it a recommendation and drop the block.
- **"Leave it as it is" is a real option** whenever it is real. Say what stays broken if it is picked.
- Never bury the question in prose above the block. If it is not in the block, it was not asked.
- A preference may be stated in **one line** under the block (`I would pick B, because …`). Never
  pick on the owner's behalf.

### Questions after the first — re-check, do not stack

A later question is only real if it survives **every** answer to an earlier one. Before writing Q2,
walk each option of Q1:

- If Q2 dies under some answers to Q1, do not ask it yet. Say so under Q1: *"If A, there is a
  follow-up about X — I will ask it then."* A dead question wastes a round trip.
- If Q2 is only *reworded* by Q1's answer, ask it in the form that holds under every answer.
- If Q2 is genuinely independent, ask it.

**Returning to an already-answered issue follows the same rule**: re-read the open questions against
the new answer, strike the ones it killed, and say which. That edit is itself useful — it shows the
owner their answer landed.

### One label, and the comment says what kind of blocked it is

`needs-decision` is the only blocking label. Whatever is needed — a pick, a discussion, a
reproduction on the party box, a verification, an answer — the label is the same, and Q1 says which:

| What is needed | How Q1 reads |
|---|---|
| A pick between enumerated options | *"Which of these should it do?"* with `A`/`B`/`C` and their costs |
| A discussion | *"This needs a conversation: I can't list the options because …"* and what would be needed to |
| A reproduction that cannot happen here | *"Can you reproduce this on the party box? Here is exactly what to try"* — name the ceiling |
| A verification of shipped work | *"PR #N is merged but I could not verify X here — does it behave on your box?"* |
| An answer to an unclear issue | *"Did you mean the phone or the TV?"* with options if any exist |

**If you can write A/B/C, write A/B/C.** Reaching for "this needs a conversation" when three options
were enumerable is the expensive outcome.

## What is wrong today

Three gaps, in increasing order of cost:

1. **Discovery latency up to 900s.** Minor, and the least interesting of the three.
2. **The re-triage lever is a label edit.** The owner's way to say "look again" is to strip `triaged`
   — an out-of-band gesture that has nothing to do with what they actually want to communicate.
3. **An answer in a comment is inert.** This is the real cost. Triage asks `Q1` and applies
   `needs-decision`. The owner replies in a comment — and nothing happens, because the only thing
   watched is the label. The owner must additionally strip `triaged` (and clear `needs-decision`) to
   signal that the comment they just wrote exists, then wait up to a poll interval.

Gap 3 is what stage 1 removes.

## Target

**Trigger set** — the events triage subscribes to, and what each one means:

| Event | Condition | Triage action |
|---|---|---|
| `issues.opened` | — | First-pass triage. Replaces query (b) |
| `issues.reopened` | — | Re-triage |
| `issues.labeled` | label is `review` | An ISSUEGEN finding arrived — stamp it. Replaces query (a) |
| `issues.unlabeled` | label is `triaged` | Re-triage. **Preserves the existing lever**, now instant |
| `issue_comment.created` | not a bot comment | **New.** If the issue carries `needs-decision`, re-read the open questions against the answer, strike the dead ones, then either clear `needs-decision` or ask the next question. Otherwise, re-look |

The fourth row matters as much as the fifth: the label lever keeps working exactly as documented, so
nothing the owner already knows how to do stops working. The comment path is **additive**.

### The marker rule — required, and not a security control

Triage posts comments. If `issue_comment.created` wakes triage, triage's own Decisions block wakes
triage again, forever. This is a feedback loop, not an abuse problem, and it must be closed before
the comment trigger is switched on.

**Author filtering cannot close it.** Every lane acts as the same GitHub user, so the bot and the
owner are indistinguishable by login.

So: **every comment any lane posts must carry an HTML marker on its first line**, and the trigger
skips any comment that has one.

```
<!-- loop-bot lane=triage -->
```

One marker already exists and must be left exactly as it is — the PR reviewer's
`<!-- pr-bot head=<full head SHA> -->`, because its verdict-freshness check greps for that literal
`head=` string. The skip predicate therefore matches either family:

```
^<!--\s*(loop-bot|pr-bot)\b
```

A lane that posts an unmarked comment will spin the loop. That is the one hard requirement stage 1
adds to every other lane.

### Debounce

An owner answering `Q1`, `Q2` and `Q3` in three comments must produce **one** triage turn, not three.
The inbox collapses pending events by issue number: all events for one issue are drained together,
the newest state wins, and every comment id in the batch is passed through so nothing is dropped.

### Reconciliation is unchanged

The event is a *doorbell*, never evidence. Triage still fetches the issue and its comments with `gh`
and reconciles against live GitHub before acting — an event can be stale by the time the turn runs,
and two events can describe the same issue. This is existing brief behaviour and it does not change.

## Acceptance criteria for stage 1

Stage 1 is done when all of these hold:

1. A newly opened issue is triaged within ~5s, with the cron paused.
2. Stripping `triaged` re-triages within ~5s.
3. Answering `Q1` in a comment causes triage to respond **without any label edit by the owner**:
   dead questions struck, and either `needs-decision` cleared or the next question asked.
4. Triage's own comment does **not** trigger another triage turn. Verified by posting one and
   observing no second turn.
5. Three comments in quick succession produce one turn.
6. Killing the forwarder mid-event loses nothing: the event is in the inbox on restart.
7. The cron can be re-enabled as a fallback with no code change — it is paused, not deleted.

## What does not change

- The house style, the Decisions block format, and the question-stacking rule are untouched.
- `triaged` still has exactly one writer.
- `TRIAGE-LOG.md` is still append-only.
- The `triaged`-removal lever still works.
