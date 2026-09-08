# Webhook ingress

How a GitHub event becomes an agent turn on this box. Reference and operations — no lane reads this
file.

Everything here lives outside the repo, at `/local/home/angryang/workspace/encore-pipeline/`, because
it holds a secret and runtime state.

## The transport

The box has no inbound reachability and the agent gateway binds `127.0.0.1` only, so the event has to
arrive over a connection the box opened itself. Reverse tunnels are not an option: every tunnel control
plane is DNS-sinkholed by the corp network, including the *named*-tunnel endpoints, so a paid account
and a custom domain do not help either. Do not work around that.

`gh webhook forward` solves it. The `cli/gh-webhook` extension registers a repo hook pointing at
GitHub's own forwarding service and holds an **outbound** connection GitHub pushes events down — the
Socket Mode shape. Nothing inbound, no tunnel. It signs the local POST with `X-Hub-Signature-256`,
which the translator verifies.

```
GitHub ──outbound push──▶ gh webhook forward ──signed POST──▶ translator (127.0.0.1:8788/gh)
                                                                   │
                              1. verify X-Hub-Signature-256        │
                              2. dedupe on X-GitHub-Delivery        │
                              3. record the event                   │
                              4. kirocrew cron trigger <job>  ──────┘
```

## Why it triggers a cron instead of running the lane

A webhook-woken agent turn runs **unattended** — it inherits whatever approval policy the gateway
started with. A turn that needs `gh` can therefore block on an approval nobody is present to give and
sit until it times out, which is indistinguishable from a wedged lane. Cron jobs do not have that
problem: they carry their own auto-approval.

So the translator rings a doorbell rather than doing the work. Two consequences:

- It needs **no gateway credential at all** — no minted webhook source, no bearer token, no signing
  secret to rotate. The only secret in the pipeline is GitHub's HMAC.
- **`cron trigger` does nothing on a *paused* job.** Verified: a trigger against a paused job produced
  no run and no log line at all. The target job must stay **enabled**, with a long interval as its
  safety net — which is why `TRIAGE-Unified` runs every 2h rather than being paused.

## Routing

One job, `TRIAGE-Unified`, handles both event classes. Both translator job variables point at it, which
also means the debounce coalesces across classes: an issue event and a comment event arriving together
produce one run that drains everything.

| Event | Routed | Recorded in |
|---|---|---|
| `issues.opened` · `.reopened` | `triage:new` | `audit/` |
| `issues.labeled` where label is `review` | `triage:stamp-review-finding` | `audit/` |
| `issues.unlabeled` where label is `triaged` | `triage:re-triage-lever` | `audit/` |
| `issue_comment.created`, not bot-authored | `triage:decision-answered` or `:comment-on-issue` | **`inbox/`** |
| `issues.unlabeled` where label is `needs-decision` | `triage:decision-cleared` | **`inbox/`** |
| a comment matching a lane's own signature | `ignored:bot-comment` | `audit/`, no trigger |
| anything else | `recorded-only` | `audit/`, no trigger |

**The two destinations track whether a consumer exists**, and a live test caught this the hard way.
`inbox/` is drained by the lane, which deletes each file when it is done — only comment-shaped events
go there, because the triage lane is the sole reader of comments and a lost one is unrecoverable.
`audit/` is write-only history, pruned at 500. Issue-shaped events go there because the lane finds that
work by label query and never reads a file; an event dropped in `inbox/` would sit forever with no
consumer. Durability is not lost: a trigger that fails to land is picked up by the safety-net pass,
which rediscovers the same work by label.

## The loop guard

The triage lane **posts comments**. If a comment event wakes it, its own comment wakes it again,
forever. Author filtering cannot close this — every lane posts as the same GitHub user.

So every comment a lane posts must carry a marker on its first line, and the translator drops any
comment that has one:

- `<!-- loop-bot lane=triage -->` — triage
- `<!-- pr-bot head=<full sha> -->` — the PR reviewer. **Leave this exact string alone**: the verdict
  freshness check greps for the literal `head=`.

Measured 2026-09-08: an unmarked triage comment on #759 was read as a human reply and burned a whole
follow-up turn. Nothing worse happened only because the lane re-checks authoritatively — the marker is
the real guard, not that backstop. The translator also matches a Decisions block, a review verdict
header and the worker status prefixes as a fallback for briefs that have not yet been updated.

## Operating it

```bash
cd /local/home/angryang/workspace/encore-pipeline
./pipelinectl.sh start     # idempotent; sweeps a leaked hook first
./pipelinectl.sh status    # expect: delivery: CONNECTED
./pipelinectl.sh sweep     # delete a leaked forwarder hook by hand
```

Three failure modes worth recognising:

**The leaked repo hook.** `gh webhook forward` registers its hook on start and removes it only on a
*clean* exit. On `SIGKILL` it leaks, and every later start dies with `422 Hook already exists`, prints
usage, and **exits 0**. A supervisor watching with `pgrep` then keeps catching the short-lived children
and reports a healthy forwarder that is **delivering nothing** — the worst shape available, because
everything looks fine. Hence: sweep before every attempt, and derive health from the forwarder log
tail, never from `pgrep`.

**Reaped with the agent turn.** Processes started inside an agent shell's process group die when the
turn ends. Start them detached (`setsid`) and confirm the translator and forwarder show `PPID 1`.

**One process per repo.** `gh webhook forward` forwards for a single repository, so each repo needs its
own forwarder, pidfile and log — and its own leak sweep.

Also worth knowing: `--secret` appears in the process command line, so it is readable via `/proc` by
any local user on the box.

## Verified behaviour

Unsigned POST → `401` · wrong path → `404` · signed `ping` → pong with no agent wake · duplicate
delivery id → ignored · issue created → event accepted in ~3s, cron triggered in ~5s, lane triaged and
closed the issue · the lane's own marked comment → `ignored:bot-comment`, no second turn.
