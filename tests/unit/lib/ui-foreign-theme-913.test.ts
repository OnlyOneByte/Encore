/*
 * ── RETIRED BY'S RESTRUCTURE (XR-VER-07) ────────────────────────────────────────────────────────
 *
 * This file asserted that a copied-in component references NO shadcn theme name — `bg-primary`,
 * `text-muted-foreground`, `border-ring` — because `app.css` defined none of them, so such a class
 * resolved to nothing and rendered unstyled.
 *
 * The restructure inverted that premise deliberately. `app.css` now defines the semantic layer
 * (`--primary: var(--accent)` and friends) and bridges it in `@theme`, precisely so a vendored
 * component works UNEDITED and `shadcn-svelte add --overwrite` stays safe across the 13 components
 * S2-S8 still brings in. Those class names are now the correct, intended mechanism. A guard banning
 * them would forbid the thing the architecture is built on.
 *
 * SUCCESSORS, which together cover strictly more than this file did:
 *   - `shadcn-ink-ban-913.test.ts` — bans the INK direction (`text-primary`, `text-destructive`, …) in
 *     app source, exempting the vendored tree by path. That is the real hazard: `--accent` as ink
 *     measures 3.85:1 on --bg, 3.38 on --card, 3.10 on --card2, 2.90 on --card-tint2. Four AA failures.
 *   - `tailwind-toolchain.test.ts` — still bans registering a PLAYER HUE in `@theme`, whose per-stop
 *     ink/fill split (13 of 48 differ) no single minted utility can respect.
 *   - `components/motion.test.ts` — its net arm is what caught `transition-all` shipping in the stock
 *     Button, and is what will catch its return after any `--overwrite`.
 *
 * Its `files.length` non-vacuity floor is retired from `non-vacuity-floors.test.ts` in the same commit,
 * as that file requires: retiring a guard without retiring its floor makes the floor fire and reads as
 * "the guard is broken, lower the number".
 */
export {};
