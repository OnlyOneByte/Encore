# `src/lib/ui/` — Encore's own primitives

**This is not the design library.** That is `src/lib/components/ui/`, one directory over and
eighty-two files bigger, and it is the `shadcn-svelte` copy-in target — see the README there.

Two directories called `ui` at different depths, meaning opposite things, is the single most
confusing thing in this tree. Read them this way:

| Directory                | Whose                                          | May be reorganised |
| ------------------------ | ---------------------------------------------- | ------------------ |
| `src/lib/components/ui/` | **vendored** — `shadcn-svelte add` writes here | **No.** See below. |
| `src/lib/ui/`            | **authored** — Encore's own                    | Yes                |

Neither name predicts its contents, so the rule has to be written down rather than inferred. It is
also stated §4 and in `docs/LAYOUT.md` §1.

## Why the vendored directory is off limits

Three independent locks, any one of which is sufficient:

1. `components.json` points the generator at that exact path. Moving it breaks every future
   `shadcn-svelte add`.
2. `src/app.css` carries exactly **one** `@source` glob and it names that directory. Tailwind emits
   utilities from that glob and nowhere else, so moving the directory stops every stock class in the
   vendored tree from being emitted — and it fails **silently**, at the CSS layer, with a green test
   suite and an unstyled app.
3. Ten guards name it by path, mostly as exemptions.

Note that "generator-owned" does **not** mean "safe to re-pull": a majority of those files already
differ from the registry, and only about half carry a deviation header. A `--overwrite` reverts the
undocumented ones without complaint.

## What lives here

Three files, and none of them wraps a shadcn primitive:

- `Icon.svelte` — one mark, drawn as inline SVG, sized in `em` so the same path serves a 44 px phone
  button and a ten-foot TV with no second asset.
- `icons.ts` — the mark registry. It exists because iOS renders `⏮ ▶ ⏸ ⏭` as colour emoji, so the
  transport controls could not be codepoints.
- `PageHeader.svelte` — one heading line for the non-`/tv` pages, so each announces where you are
  and offers the same way back, instead of hand-rolling its own chrome.

## The wrapper layer this was meant to hold

The intended shape: keep the vendored tree pristine and wrap it one
layer up, with `ActionButton.svelte` built on the vendored `Button` as the worked example.

**That file does not exist, and no file here wraps a vendored primitive.** The wrapper layer is
essentially unbuilt — which is worth knowing before you go looking for it. If you add one, this is
where it goes, and the vendored component it builds on stays untouched.
