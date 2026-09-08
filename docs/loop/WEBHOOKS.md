# Webhook ingress

How a GitHub event reaches an agent on this box, and why the path looks the way it does.

## The problem

The box is a corp machine with no inbound reachability, and the agent gateway binds `127.0.0.1` only.
GitHub POSTs from the public internet. So the event has to arrive over a connection the box opened
itself.

Reverse tunnels are not available: every tunnel control plane is DNS-sinkholed to
`chalupa-dns-sinkhole.corp.amazon.com` — `api.trycloudflare.com`, `region1/2.v2.argotunnel.com` (the
*named*-tunnel control plane, so a paid account and a custom domain do not help),
`connect.ngrok-agent.com`, and `login/controlplane.tailscale.com`. That is a deliberate control
aimed at exactly this class of tooling. Do not work around it.

## The mechanism: `gh webhook forward`

The official `cli/gh-webhook` extension registers a repo hook pointing at GitHub's own
`https://webhook-forwarder.github.com/hook` and holds an **outbound** connection that GitHub pushes
events down — the same shape as Slack's Socket Mode. Nothing inbound, no tunnel, and none of its
endpoints are sinkholed.

It takes `--secret`, so it signs the local POST with `X-Hub-Signature-256`, which the translator
verifies. This is strictly better than a tunnel on security: with a tunnel, an endpoint that runs
agent turns would have been publicly addressable. Here nothing about the box is reachable from
outside at all.

```
GitHub ──outbound, GitHub-initiated push──▶ gh webhook forward (one process per repo)
                                                    │ signed POST, loopback
                                                    ▼
                                           translator  (127.0.0.1:8787)
                                             1. verify X-Hub-Signature-256
                                             2. dedupe on X-GitHub-Delivery
                                             3. write one JSON file to inbox/  ← durable, happens
                                                                                 BEFORE any dispatch
                                             4. dispatch (or not — see wake modes)
```

Writing to the inbox **before** dispatching is the property that makes an edge unmissable. A crash,
a busy session, or a gateway restart cannot lose the event.

## Two known traps

**The leaked repo hook.** `gh webhook forward` creates its repo hook on start and removes it only on
a *clean* exit. On `SIGKILL` it leaks, and every subsequent start dies with `422 Hook already
exists`, prints usage, and **exits 0**. A supervisor that watches with `pgrep` then keeps catching
the short-lived children and reports a healthy forwarder that is **delivering nothing** — the worst
available failure shape, because everything looks fine. Two mitigations, both required:

- The watch loop sweeps the leaked hook before every restart attempt, making restart idempotent.
- Health is derived from the **last meaningful line of the forwarder log**, never from `pgrep`.

**One process per repo.** `gh webhook forward` forwards for a single repository, so each repo needs
its own forwarder process, pidfile and log. The leak sweep above must be per-repo too.

**`--secret` is visible in the process command line**, so it is readable via `/proc` by any local
user. Single-user devbox, but it is worth knowing.

## Bridging into a live session

This is the design decision that actually matters, and it exists because of two hard properties of
the agent gateway's webhook endpoint:

- `POST /api/hooks/agent` **refuses** to inject into a dashboard session. `sessionKey` must start
  with `hook:` — an explicit namespace guard, documented as keeping "a webhook caller from steering
  its turn into one of your dashboard or Slack sessions by naming that session's key."
- Hook sessions are **ephemeral**. One turn, then destroyed. Continuity is only a `register_hook`
  summary: 5,000 characters, verbatim under 1h, flagged as stale from 1–24h, dropped entirely after
  24h.

Encore's Dev and Review orchestrators are long-lived dashboard sessions holding accumulated rulings
and in-flight tables — far more than 5,000 characters, and losing it is not acceptable. So there are
three ways to bridge, and they trade differently:

| | **A. Inbox + existing patrol** | **B. Doorbell relay** | **C. Fully hook-native** |
|---|---|---|---|
| How the lane learns | its existing monitor loop drains the inbox instead of polling `gh` | a tiny hook session relays a one-line notice into the live session via `session_send`, then dies | the lane itself runs as an ephemeral hook turn on a fixed `sessionKey` |
| Pickup latency | ≤ one loop interval | ~2s | ~1s |
| Orchestrator context | preserved | preserved | **lost** — must be re-externalized to disk |
| Cost per quiet cycle | one agent turn | none | none |
| New components | translator + forwarder | + one minimal relay agent | + a state rewrite |
| Needs an unattended approval policy | no | yes, for **one** known tool call | yes, for arbitrary `gh` |

**The staged plan uses A first, then B.** A is proven and cannot lose context; B is a small additive
piece that collapses latency without disturbing anything already working. C is the purist answer and
is rejected for Encore specifically: the conductor's accumulated context is what makes it good, and
`register_hook` cannot carry it.

For a lane driven by a **cron** rather than a live session — triage today — A is even simpler: the
event lands in the inbox and the lane is woken by the doorbell, with the cron kept as a paused
fallback.

### The unattended-turn caveat

A hook turn is unattended: *"No one approves tool calls on the agent's behalf, so the turn runs with
whatever approval policy the gateway was started with."* A turn that needs a tool nobody can approve
starts, blocks, and sits until its timeout — which looks exactly like a wedged orchestrator. This is
why option B is scoped to a **single** known tool call rather than arbitrary shell: it is a far
smaller thing to grant.

## Wake modes

The translator carries an explicit `WAKE_MODE` so the ingress can be brought up without a second
brain racing the first:

| Mode | Behaviour |
|---|---|
| `inbox` | Verify, dedupe, write to the inbox. **No dispatch.** Inert until a lane reads it — safe to enable while a wave is in flight |
| `hook` | Additionally wake an ephemeral hook session per event |

Bringing a lane up in `inbox` mode first is the safe cutover: the events accumulate durably and
nothing acts on them until the lane is switched over deliberately.

## Payload shape

The translator forwards **structured scalars** — issue or PR number, action, label name, comment id,
delivery id — and not repository prose. Two things worth being accurate about:

- This began as a prompt-injection containment boundary when the repo was public and issue text was
  attacker-supplied. **Encore is now private**, so that justification no longer applies.
- It is kept anyway because it costs nothing: the code is already written and proven, and every lane
  brief already requires reconciling against live GitHub with `gh` rather than trusting the event.
  The body gets read either way. What went away is a documented security boundary and an
  author-association gate, not any code.

One residual worth recording without treating it as a control: the ISSUEGEN passes file issues
automatically, so much of what triage reads is machine-written. That is prompt hygiene, not a threat
model.

## Operational surface

| Path | Purpose |
|---|---|
| `pipelinectl.sh` | Supervisor: `start` / `stop` / `status` / `url` / `sync`, plus the watch loop with the per-repo leaked-hook sweep |
| `translator.py` | Loopback HTTP listener: HMAC verify, delivery dedupe, durable inbox write, dispatch |
| `inbox/` | One JSON file per event, deleted by the lane only after it finishes with it |
| `state/` · `logs/` | Dedupe state and forwarder logs — `status` reads health from the log tail |

Verified gate behaviour on this design: an unsigned POST is rejected `401`, a wrong path `404`, a
signed `ping` returns pong with no agent wake, and a second event arriving while a turn is running
returns `409 session_busy` with the event left durable in the inbox for retry.
