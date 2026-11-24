# PR self-review checklist

Run this before you open a pull request. Every line is a must-fix that a reviewer found in a real PR, and the link
goes to that PR. Answer the sections the PR touches and name them in the PR body. A UI PR also answers the
[UI checklist](UI-CHECKLIST.md). The review still happens; this list is for catching the repeats before it does.

## Server and routes

- Can a guest, a cookieless client or a script call the new route or fill the new cap, and what does that lock out
  (the TV, the host)? [#1204]
- Is a host-only route gated in its own `+server.ts` with `can(...)`, not only by a path test in the hook? [#1140]
- Does any check read `url.pathname`? Gate on `event.route.id`, and try `/%61pi/...` against it. [#1140]
- Does every new POST go through the Origin check and require `application/json`? [#1140]
- Does a `null`, empty or wrong-typed body get a 400, not a 500? [#1140]
- Can a store or file call on a hot path (a pick, a join) throw or hang? Is it bounded, falling back to the old
  behaviour? [#1161]
- Is there an `await` between a check and the act it guards, where another request can slip in? [#1179]
- Does every writer of a shared file such as `meta/<id>.json` go through the per-id write queue? [#1179] [#1183]
- Does the change reach every screen that shows it, phones and the TV, while they are open? [#1179] [#1161]
- Does the route refuse a song that is mid-process, evicted or pending delete, rather than report it ready? [#1179]
- Does changing or deleting something in tonight's queue refuse, or tell the singer? [#1179]
- Does a metric count only finished work, tested through the real repository rather than hand-made rows? [#1135]
- Are odd inputs (no length, a clock that jumped back, a capped list) counted and said, not dropped or
  clamped? [#1135]
- Does the disk cap and eviction cover every file the PR keeps, and does evicted data come back on the next
  pick? [#1137]

## Phone UI

- Does any data arrive after first paint (fetched in `onMount`)? Load it in `+page.server.ts`, so a cold load has
  CLS 0. [#1204]
- If the response is lost or the tab closes mid-request, does the phone keep a working state? [#1193]
- Two tabs or a double tap at once: is the second one harmless, with buttons disabled while a request is in
  flight? [#1193] [#1204]
- Does content ever wait behind an indicator, such as a skeleton's minimum hold? [#1171]
- With a slow answer (over 300 ms), does focus still land where it should? Is there a probe with a slowed
  response? [#1171]
- Does every lazy `import()` or `{#await}` have a `{:catch}` with a way out? [#1171]
- At 320 wide, does the content the screen is for still start above the dock? [#1171] [#1179]
- Is an exclusive choice a radio group with arrow keys, and does the focus ring reach 3:1 on every fill? [#1139]
- Does an empty `role="status"` region stay in the accessibility tree? [#1204]
- Does every failure tell the person what happened and offer the next move? [#1179]

## TV

- Can a hidden or sleeping control take a touch tap or a double click as it wakes? Test with `hasTouch` and
  `touchscreen.tap`, not only a mouse. [#1195]
- Can the real TV always get back in after its seat lapses, whatever extra screens or guests do? [#1204]
- Does the TV get the change live, or only at its next full sync? [#1179]
- Can a moving marker, such as the current lyric row, step back across a swap or a nudge? [#1183]
- Does state set from a stream (a rate trim) reset when the stream stops? [#1174]

## Worker

- Are DBOS workflows declared before `DBOS.launch()`, and does a crash with a job in flight resume, not
  hang? [#1177]
- Does a speed claim rest on alternating runs (main, head, main, head), with the lone pick measured too? [#1177]
- Do 3 real songs reach ready with non-silent stems and lyrics on the new setting? [#1133] [#1177] [#1051]
- Are threads split only where work really runs side by side, not for models under `ML_LOCK`? [#1177]
- Is a kept or cached file checked (non-empty, the right size) before it is trusted? [#1137]
- Does a downloader change keep every track main kept? Test it with a real video's key set. [#1137]
- Do core and the worker clean and compare a shared value, such as a token, the same way? [#1200] [#1202]

## Security

- Can a secret the operator set clean down to "unset" and turn auth off? It must fail closed. [#1200]
- Can a served root such as `/media` reach a secret or the database? Compare real paths, symlinks
  included. [#1202] [#1207]
- Does the code chmod only directories it owns, never a shared `/tmp` or `$HOME`? Does it repair a file that is
  too open? [#1202]
- Is a directory shared with another uid sticky, so that uid can't rename what core owns? [#1207]
- Do logs and errors name the file or variable, never the secret? [#1202] [#1194]
- Does a limiter protect anything the key length doesn't, and can a flood reset it or lock out the owner behind a
  shared address? [#1140] [#1190]
- Does a copied cookie die when its token rotates, and does rotation survive a lost response? [#1193]
- Do the threat-model rows in `SERVER.md` say what the code does now? [#1140] [#1190] [#1193]

## Tests

- Does each new test fail on the old code? Revert the fix, or apply a mutant, and watch it go red. [#1161] [#1145]
- Does the test drive the real input (touch, a slow network, a real key set), not only the happy path? [#1195]
  [#1171] [#1137]
- Did you run every probe that exercises the changed path (grep the probes for the changed functions and UI
  actions), and `bun run test`? [#1043] [#1140]
- Do Docker test containers run with `--network encore-hermetic` and `--user $(id -u):$(id -g)`, so scratch
  folders stay deletable? [#1200] [#1174]
- Can parallel test workers race on a shared cache, such as vite's deps folder? [#1139]
- Does a dev or test flag do what it says? Check by watching it work. [#1171]

## Process

- Is `git merge-tree --write-tree origin/main HEAD` clean? Does an open PR edit the same compose, server or TV file?
  Two `group_add` blocks merge silently into a duplicate key. [#1194] [#1207] [#1202]
- Do the docs claim only what the code does ("every screen", "never steps back")? [#1161] [#1183] [#1147]
- Is each comment one or two lines of why, and is no stale comment left in the code the PR changes? [#1137]
  [#1139] [#1171]
- Are links in the PR template and body absolute? [#1111]
- Does the body say `Closes #N` only when every "done when" line is met, and `Part of #N` otherwise? [#1171]
- Do the body's claims (gate counts, "every probe passed", a clean merge) hold on the head commit? [#1140] [#1174]
- Is UI media recorded on the head commit? [#1183]
- Are commits by OnlyOneByte's no-reply address, with no personal data in the diff, body, logs or
  screenshots? [#1189] [#1202]

[#1043]: https://github.com/OnlyOneByte/Encore/pull/1043
[#1051]: https://github.com/OnlyOneByte/Encore/pull/1051
[#1111]: https://github.com/OnlyOneByte/Encore/pull/1111
[#1133]: https://github.com/OnlyOneByte/Encore/pull/1133
[#1135]: https://github.com/OnlyOneByte/Encore/pull/1135
[#1137]: https://github.com/OnlyOneByte/Encore/pull/1137
[#1139]: https://github.com/OnlyOneByte/Encore/pull/1139
[#1140]: https://github.com/OnlyOneByte/Encore/pull/1140
[#1145]: https://github.com/OnlyOneByte/Encore/pull/1145
[#1147]: https://github.com/OnlyOneByte/Encore/pull/1147
[#1161]: https://github.com/OnlyOneByte/Encore/pull/1161
[#1171]: https://github.com/OnlyOneByte/Encore/pull/1171
[#1174]: https://github.com/OnlyOneByte/Encore/pull/1174
[#1177]: https://github.com/OnlyOneByte/Encore/pull/1177
[#1179]: https://github.com/OnlyOneByte/Encore/pull/1179
[#1183]: https://github.com/OnlyOneByte/Encore/pull/1183
[#1189]: https://github.com/OnlyOneByte/Encore/pull/1189
[#1190]: https://github.com/OnlyOneByte/Encore/pull/1190
[#1193]: https://github.com/OnlyOneByte/Encore/pull/1193
[#1194]: https://github.com/OnlyOneByte/Encore/pull/1194
[#1195]: https://github.com/OnlyOneByte/Encore/pull/1195
[#1200]: https://github.com/OnlyOneByte/Encore/pull/1200
[#1202]: https://github.com/OnlyOneByte/Encore/pull/1202
[#1204]: https://github.com/OnlyOneByte/Encore/pull/1204
[#1207]: https://github.com/OnlyOneByte/Encore/pull/1207
