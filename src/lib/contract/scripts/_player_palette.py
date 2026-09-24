#!/usr/bin/env python3
"""
Encore 48-stop player palette, where a guest's identity colour IS their UI accent.

This is the generator behind `src/lib/contract/presentation/player-palette-48.json`, the one
machine-readable source of truth for the 48 stops. Run it from anywhere; paths are repo-relative:

    python3 src/lib/contract/scripts/_player_palette.py

The surfaces every figure is measured against are READ from `src/app.css`, never restated
here -- see `css_token` below for what that cost when they were restated. Regenerating
against unchanged inputs reproduces the committed registry byte-for-byte, which is the reproducibility
claim `palette-registry.test.ts` asserts.

Two variants, both fully measured:

  UNIFORM   -- lightness pinned for all 48. One dark ink provably clears AA on every
               hue, which is the property the current 8-value design leans on. Cost:
               forcing yellow DOWN and blue UP to a single L removes true yellow and
               true blue from the palette entirely (mustard and periwinkle instead).

  CHROMATIC -- lightness follows each hue's gamut cusp, so yellow sits light and blue
               sits deep. Gives real yellow and real blue and far more chroma. Cost:
               ink is no longer one rule -- each stop carries its own, flipping between
               dark and light. That cost is already paid, because the accent role needs
               a per-stop on-fill ink regardless.

Roles measured for every stop, because as an accent the colour gains jobs the dot
never had:
  dot on --bg / --card  >= 3.0   (non-text fill, the only role checked today)
  label on the fill     >= 4.5   (primary button now wears the player's colour)
  accent as ink on card >= 4.5   (bylines, position, links)
"""
import math
import json
import os
import re
import colorsys
import pathlib

HERE = pathlib.Path(__file__).parent


def _repo_root() -> pathlib.Path:
    """The repo root, found by walking up for `bunfig.toml`.

    NOT a hop count. `HERE.parents[2]` encoded this script's distance from the root, so the next move of
    the shared tree made it resolve to `src/`, where the generator looked for `app.css` and found nothing.

    `bunfig.toml` is the marker because it is what the test harness uses to find the same root, so the
    guard that regenerates this file and the script itself agree by construction — and a hop count
    cannot silently survive the next move.
    """
    for candidate in [HERE, *HERE.parents]:
        if (candidate / "bunfig.toml").is_file():
            return candidate
    raise SystemExit(f"_player_palette: no bunfig.toml above {HERE}")


REPO = _repo_root()
APP_CSS = REPO / "src" / "app.css"
# The committed registry, unless a caller redirects it. `PLAYER_PALETTE_OUT` is how the freshness
# guard regenerates into a temp file without dirtying the working tree.
OUT = pathlib.Path(os.environ.get("PLAYER_PALETTE_OUT")
                   or REPO / "src" / "lib" / "contract" / "presentation" / "player-palette-48.json")

N_STOPS = 48
START_HUE = 29.0            # red, so the wheel reads red -> ... -> magenta -> red
L_PIN = 0.72                # UNIFORM variant
C_CAP = 0.21
L_WINDOW = (0.56, 0.88)     # CHROMATIC clamp: keeps the dot legible and ink achievable

AA = 4.5                    # WCAG 1.4.3, body text
NON_TEXT = 3.0              # WCAG 1.4.11, a dot carries no text
# Headroom the accent-as-ink role is lifted PAST its floor. It used to stop the moment it
# touched AA exactly, so `min_ink_card` shipped at 4.500 with ~0.00 to spare and the surface
# correction below crossed it for six stops. One constant, read by both the lift loop and the gate,
# so the two can never disagree about what "clears" means. 0.05 is measured, not guessed: it moves
# six inks and leaves nothing unresolved.
INK_MARGIN = 0.05


def css_token(name):
    """Read a `--name: #rrggbb;` declaration out of `app.css`.

    The surfaces are NOT restated here. The generator used to carry its own
    `#060a18 / #131a2e / #1a2238` — the mockup's surfaces, not the app's — so all 192 measured
    figures described a card the app never paints, and six stops shipped below AA as ink. Reading the
    token means changing `--card` in `app.css` changes what a regeneration produces, which is
    the second acceptance clause. Same regex as the guard in `colors.test.ts`, and it
    raises rather than defaulting so a renamed token stops the build instead of measuring a stale
    copy.
    """
    m = re.search(rf"--{name}:\s*(#[0-9a-fA-F]{{3,8}})\s*;", APP_CSS.read_text())
    if not m:
        raise SystemExit(f"token --{name} not found in {APP_CSS} (renamed? then update this reader)")
    hex_v = m.group(1)
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", hex_v):
        raise SystemExit(f"--{name} is {hex_v}; this generator measures 6-digit hex only")
    return hex_v.lower()


BG, CARD, CARD2 = (css_token(n) for n in ("bg", "card", "card2"))
STATUS = {"danger": 22.0, "warn": 82.0, "ok": 158.0}

# ------------------------------------------------------------------ colour math

def oklch_to_linear(L, C, h_deg):
    h = math.radians(h_deg)
    a, b = C * math.cos(h), C * math.sin(h)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    return (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)


def in_gamut(L, C, h, eps=1e-4):
    return all(-eps <= v <= 1 + eps for v in oklch_to_linear(L, C, h))


def enc(u):
    u = max(0.0, min(1.0, u))
    return 1.055 * u ** (1 / 2.4) - 0.055 if u > 0.0031308 else 12.92 * u


def oklch_hex(L, C, h):
    return "#" + "".join(f"{round(enc(v) * 255):02x}" for v in oklch_to_linear(L, C, h))


def max_chroma(L, h, cap=C_CAP):
    if in_gamut(L, cap, h):
        return cap
    lo, hi = 0.0, cap
    for _ in range(40):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if in_gamut(L, mid, h) else (lo, mid)
    return lo


def cusp_L(h):
    """Lightness where this hue reaches its widest chroma in sRGB."""
    best, bestL = -1, L_PIN
    L = 0.30
    while L <= 0.95:
        c = max_chroma(L, h)
        if c > best:
            best, bestL = c, L
        L += 0.005
    return min(max(bestL, L_WINDOW[0]), L_WINDOW[1])


def hex_rgb(s):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))


def luminance(rgb):
    def lin(u):
        return u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(f, b):
    x, y = luminance(hex_rgb(f)), luminance(hex_rgb(b))
    hi, lo = max(x, y), min(x, y)
    return (hi + 0.05) / (lo + 0.05)


def ab(L, C, h):
    r = math.radians(h)
    return C * math.cos(r), C * math.sin(r)


def dE(p, q):
    a1, b1 = ab(*p)
    a2, b2 = ab(*q)
    return math.dist((p[0], a1, b1), (q[0], a2, b2))


# ------------------------------------------------------------------ naming
# Names are assigned from the MEASURED sRGB hue of the generated hex, not from the
# OKLCH angle -- the two disagree sharply (OKLCH 199 is cyan, not mint), and a picker
# that mislabels a swatch is worse than one with no names. The name also does real
# work: it is the non-colour carrier of identity for a colour-blind guest.
FAMILIES = [
    (0, 15, ["Redline", "Scarlet", "Crimson", "Vermilion", "Cherry", "Firebrick"]),
    (15, 41, ["Ember", "Flare", "Rust", "Cinder", "Persimmon", "Copper", "Bronze", "Clay"]),
    (41, 71, ["Amber", "Brass", "Mustard", "Gold", "Wheat", "Olive", "Khaki", "Sulphur"]),
    (71, 161, ["Acid", "Lime", "Chartreuse", "Fern", "Clover", "Viridian", "Jade",
               "Emerald", "Spring", "Moss", "Pine", "Verdant", "Mint", "Shamrock",
               "Basil", "Malachite"]),
    (161, 201, ["Teal", "Seafoam", "Turquoise", "Lagoon", "Aqua", "Reef", "Coolant",
                "Cyan", "Tidal", "Kelp", "Abyss", "Spearmint"]),
    (201, 251, ["Glacier", "Sky", "Azure", "Cerulean", "Cobalt", "Denim", "Electric",
                "Sapphire", "Arctic"]),
    (251, 291, ["Periwinkle", "Iris", "Violet", "Amethyst", "Lavender", "Ultra",
                "Indigo", "Wisteria"]),
    (291, 331, ["Magenta", "Fuchsia", "Orchid", "Mulberry", "Byzantine", "Grape", "Plum"]),
    (331, 360, ["Rose", "Hibiscus", "Blossom", "Flamingo", "Punch", "Peony", "Candy"]),
]


def assign_names(fills):
    srgb_hues = [colorsys.rgb_to_hsv(*hex_rgb(f))[0] * 360 for f in fills]
    pools = {i: list(fam[2]) for i, fam in enumerate(FAMILIES)}
    used, names = set(), []
    for h in srgb_hues:
        fi = next((i for i, (lo, hi, _) in enumerate(FAMILIES) if lo <= h < hi),
                  len(FAMILIES) - 1)
        pick = next((cand for cand in pools[fi] if cand not in used), None)
        if pick is None:                       # family exhausted: number within it
            base = FAMILIES[fi][2][0]
            n = 2
            while f"{base} {n}" in used:
                n += 1
            pick = f"{base} {n}"
        used.add(pick)
        names.append(pick)
    return names


# ------------------------------------------------------------------ build

def stop_geometry(mode):
    """Place N stops at equal cumulative OKLab distance around the wheel. Equal ANGLE
    bunches stops where the gamut is narrow and spreads them where it is wide."""
    step = 0.25
    fine = [(START_HUE + i * step) % 360 for i in range(int(360 / step))]
    if mode == "uniform":
        pts = [(L_PIN, max_chroma(L_PIN, h), h) for h in fine]
    else:
        pts = []
        for h in fine:
            L = cusp_L(h)
            pts.append((L, max_chroma(L, h), h))
    cum, tot = [0.0], 0.0
    for i in range(1, len(pts) + 1):
        tot += dE(pts[i - 1], pts[i % len(pts)])
        cum.append(tot)
    want, out, j = tot / N_STOPS, [], 0
    t = 0.0
    for _ in range(N_STOPS):
        while j < len(cum) - 1 and cum[j] < t:
            j += 1
        out.append(pts[min(j, len(pts) - 1)])
        t += want
    return out


def pick_ink(fill, L, C, h):
    """The ink that goes ON the player's colour, and the fill it is valid for.

    Returns (fill, ink, kind). Dark ink is preferred -- it keeps a bright fill reading
    as the brand rather than muddying it. White is used when the fill is too deep for
    dark to clear AA. If a fill sits in the mid-luminance dead zone where NEITHER ink
    clears, the fill itself is moved away from the middle and the MOVED fill is
    returned, because validating an ink against a fill the caller never adopts is how
    a stop ends up shipping an illegible label that measures fine on paper.
    """
    dark = oklch_hex(0.17, min(C * 0.28, 0.045), h)
    if contrast(dark, fill) >= AA:
        return fill, dark, "dark"
    if contrast("#ffffff", fill) >= AA:
        return fill, "#ffffff", "light"
    lo, hi = L, L
    for _ in range(160):
        lo -= 0.004
        hi += 0.004
        for cand_L, tag in ((hi, "up"), (lo, "down")):
            if not (0.30 <= cand_L <= 0.95):
                continue
            f2 = oklch_hex(cand_L, max_chroma(cand_L, h, C), h)
            # `dark` again rather than a fresh one: the dark ink is a function of hue and chroma alone, so
            # moving the FILL's lightness cannot change it.
            if contrast(dark, f2) >= AA:
                return f2, dark, f"dark (L {tag} {cand_L:.3f})"
            if contrast("#ffffff", f2) >= AA:
                return f2, "#ffffff", f"light (L {tag} {cand_L:.3f})"
    return fill, "#ffffff", "UNRESOLVED"


def build(mode):
    geom = stop_geometry(mode)
    fills = [oklch_hex(L, C, h) for L, C, h in geom]
    names = assign_names(fills)

    stops = []
    for i, ((L, C, h), fill) in enumerate(zip(geom, fills)):
        # pick_ink may move the fill out of the mid-luminance dead zone; adopt its
        # answer so every measurement below describes the colour actually shipped.
        fill, ink, ink_kind = pick_ink(fill, L, C, h)
        r, g, b = hex_rgb(fill)
        srgb_now = colorsys.rgb_to_hsv(r, g, b)[0] * 360

        # The accent used AS INK on a card. Raise L until it clears AA WITH MARGIN; the fill itself
        # is only guaranteed for the non-text dot role. Stopping at bare AA is what shipped six stops
        # at 4.500 against the mockup card and below 4.5 against the real one.
        aL, aink = L, fill
        while contrast(aink, CARD) < AA + INK_MARGIN and aL < 0.97:
            aL += 0.005
            aink = oklch_hex(aL, max_chroma(aL, h, C), h)

        h2 = (h + 42) % 360
        L2 = L if mode == "uniform" else cusp_L(h2)
        stops.append(dict(
            i=i + 1, name=names[i], hue=round(h, 1), srgb_hue=round(srgb_now),
            L=round(L, 3), chroma=round(C, 4), fill=fill,
            on_fill=ink, ink_kind=ink_kind, accent_ink=aink,
            accent2=oklch_hex(L2, max_chroma(L2, h2), h2),
            r_dot_bg=round(contrast(fill, BG), 2),
            r_dot_card=round(contrast(fill, CARD), 2),
            r_label=round(contrast(ink, fill), 2),
            r_ink_card=round(contrast(aink, CARD), 2),
            d_danger=round(min(abs(h - STATUS["danger"]), 360 - abs(h - STATUS["danger"])), 1),
            d_warn=round(min(abs(h - STATUS["warn"]), 360 - abs(h - STATUS["warn"])), 1),
            d_ok=round(min(abs(h - STATUS["ok"]), 360 - abs(h - STATUS["ok"])), 1),
        ))

    neigh = [dE(geom[i], geom[(i + 1) % len(geom)]) for i in range(len(geom))]
    worst, pair = 9, None
    for a in range(len(geom)):
        for b in range(a + 1, len(geom)):
            d = dE(geom[a], geom[b])
            if d < worst:
                worst, pair = d, (stops[a]["name"], stops[b]["name"])

    # Strict comparisons, deliberately. the acceptance is that every stop clears its floor
    # with margin > 0 -- a stop sitting exactly ON the floor is what this issue is about, so it
    # counts as a failure here. The figures compared are the rounded ones the registry publishes, so
    # a true 4.502 rounds to 4.5 and is flagged: erring toward a loud failure is the point.
    fail = [s["name"] for s in stops
            if s["r_dot_bg"] <= NON_TEXT or s["r_dot_card"] <= NON_TEXT
            or s["r_label"] <= AA or s["r_ink_card"] <= AA]
    stats = dict(
        mode=mode, n=len(stops), failures=fail,
        surfaces=dict(bg=BG, card=CARD, card2=CARD2),
        floors=dict(dot=NON_TEXT, label=AA, ink=AA, ink_target=AA + INK_MARGIN),
        min_dot_bg=min(s["r_dot_bg"] for s in stops),
        min_dot_card=min(s["r_dot_card"] for s in stops),
        min_label=min(s["r_label"] for s in stops),
        min_ink_card=min(s["r_ink_card"] for s in stops),
        dup_hex=len(stops) - len({s["fill"] for s in stops}),
        ink_dark=sum(1 for s in stops if s["ink_kind"].startswith("dark")),
        ink_light=sum(1 for s in stops if s["ink_kind"].startswith("light")),
        unresolved=[s["name"] for s in stops if s["ink_kind"] == "UNRESOLVED"],
        min_neighbour_dE=round(min(neigh), 4), max_neighbour_dE=round(max(neigh), 4),
        neighbour_spread=round(max(neigh) / min(neigh), 2),
        min_pair_dE=round(worst, 4), min_pair=pair,
        L_min=round(min(s["L"] for s in stops), 3),
        L_max=round(max(s["L"] for s in stops), 3),
        chroma_min=round(min(s["chroma"] for s in stops), 4),
        chroma_max=round(max(s["chroma"] for s in stops), 4),
        near_danger=[s["name"] for s in stops if s["d_danger"] <= 20],
        near_warn=[s["name"] for s in stops if s["d_warn"] <= 20],
        near_ok=[s["name"] for s in stops if s["d_ok"] <= 20],
    )
    return stops, stats


if __name__ == "__main__":
    doc = {"surfaces": dict(bg=BG, card=CARD, card2=CARD2), "variants": {}}
    for mode in ("uniform", "chromatic"):
        stops, stats = build(mode)
        doc["variants"][mode] = dict(stops=stops, stats=stats)
        print(f"===== {mode.upper()} =====")
        for k in ("failures", "min_dot_bg", "min_label", "min_ink_card", "dup_hex",
                  "ink_dark", "ink_light", "unresolved", "min_neighbour_dE",
                  "neighbour_spread", "min_pair", "L_min", "L_max",
                  "chroma_min", "chroma_max"):
            print(f"  {k:<18}{stats[k]}")
        print(f"  near_danger({len(stats['near_danger'])}) "
              f"near_warn({len(stats['near_warn'])}) near_ok({len(stats['near_ok'])})")
        print()
    OUT.write_text(json.dumps(doc, indent=1))
    print(f"wrote {OUT}")
