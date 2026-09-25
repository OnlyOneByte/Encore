/*
 * DELIBERATELY EMPTY. This file banned shadcn theme names (`bg-primary`, `text-muted-foreground`) in a
 * copied-in component, on the premise that `app.css` defined none of them. `app.css` now defines the
 * semantic layer and bridges it in `@theme` so a vendored component works UNEDITED, which makes those
 * class names the intended mechanism — a guard banning them would forbid the architecture.
 *
 * Covered instead by `shadcn-ink-ban.test.ts` (the INK direction, the real contrast hazard),
 * `tailwind-toolchain.test.ts` and `components/motion.test.ts`. The full retirement record, including the
 * retired `files.length` floor, is in `tests/guards/meta/non-vacuity-floors.test.ts`.
 */
export {};
