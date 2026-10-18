"""Testing hunt 3b: the kernel's sketch_outline against the independent
Python model (sketch_outline.py) on seeded random sketches.

Each seed makes one sketch (random.Random(seed), so the same seed always
makes the same sketch) from one of these families, chosen by the seed:
- polygon: 3 to 9 corners on a whole-number grid, scaled (1 um to 100 m
  steps) and moved (up to 10 km out), either sorted round their middle (a
  simple polygon, usually closed) or in random order (usually crossing);
  lines listed in a shuffled order, some drawn backwards, and with
  probability 1/2 every end nudged by up to 0.35 LINEAR, so ends join
  within LINEAR rather than exactly;
- broken: a polygon with a line dropped (a loose end), a line added from
  a corner (a branch), a line drawn twice, a second polygon or a circle
  added (several loops);
- boundary: the thresholds at 0.9x (must pass) and 1.1x (must fail) of
  LINEAR (a gap at a join, an arc's centre off its bisector),
  MIN_FEATURE (a line's length, a corner standing that far off a side, a
  spike that far wide, a circle's radius), MAX_SIZE (the span, a circle's
  radius at MAX_SIZE / 2) and MAX_COORD (a line end that far out);
- arcs: rectangles and triangles with sides bowed out or in as arcs (a
  centre on the side's bisector), a D (a line and an arc) and a lens (two
  arcs), shuffled and drawn backwards like the polygons, and broken the
  same ways;
- circles: one, several, or one with a polygon.

The kernel answers through the same call the app makes
(`sketch_outline_of`, via kernel/examples/sketch_outline_json.rs). The two
must agree on the kind of answer and everything it carries: the curve an
error names; a loose end's or branch's point (to the bit) and a branch's
end count; the loop count; for a closed outline every corner (to the
bit), every bulge (to 1e-9 relative: two formulas) and every piece's
curve, index and direction; for an outline that is not a profile, the
curves named. Loops with arcs are compared when the kernel accepts them
(their profile rules are not modelled); cases the model calls too close
to call in doubles are left out and counted.

Usage: python3 sketch_outline_check.py [seeds, default 10000] [first seed, default 1]
Exit 1 on any disagreement; each is written to stdout with its seed and
sketch, ready to be kept as a regression.
"""

import json
import math
import os
import random
import struct
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import sketch_outline as model  # noqa: E402

KERNEL = os.path.join(os.path.dirname(__file__), "..", "..", "kernel")

LINEAR, MIN_FEATURE, MAX_SIZE, MAX_COORD = model.LINEAR, model.MIN_FEATURE, model.MAX_SIZE, model.MAX_COORD


# ---- sketches ---------------------------------------------------------------

def polygon_points(rng, simple):
    k = rng.randint(3, 9)
    pts = set()
    while len(pts) < k:
        pts.add((rng.randint(0, 20), rng.randint(0, 20)))
    pts = list(pts)
    if simple:
        mx = sum(p[0] for p in pts) / k
        my = sum(p[1] for p in pts) / k
        pts.sort(key=lambda p: math.atan2(p[1] - my, p[0] - mx))
    else:
        rng.shuffle(pts)
    return pts


def place(rng, pts):
    """Scale a whole-number figure and move it out, as doubles."""
    unit = rng.choice([1.0, 0.5, 0.25, 0.1, 10.0, 0.01, 100.0, 1000.0, 0.005])
    far = rng.choice([0.0, 0.0, 1.0, 1000.0, 123456.0, 1e7])
    ox, oy = rng.randint(-50, 50) * far, rng.randint(-50, 50) * far
    return [(ox + x * unit, oy + y * unit) for x, y in pts]


def ring(pts):
    return [(pts[i], pts[(i + 1) % len(pts)]) for i in range(len(pts))]


def nudge(rng, p, by):
    """p moved by up to `by` in a random direction (exactly representable or not)."""
    t = rng.random() * 2 * math.pi
    s = rng.random() * by
    return (p[0] + s * math.cos(t), p[1] + s * math.sin(t))


def jumble(rng, lines, arcs=(), nudged=True):
    """Shuffle, draw some backwards, and maybe nudge every end within 0.35 LINEAR."""
    lines = list(lines)
    rng.shuffle(lines)
    lines = [(b, a) if rng.random() < 0.5 else (a, b) for a, b in lines]
    if nudged and rng.random() < 0.5:
        lines = [(nudge(rng, a, 0.35 * LINEAR), nudge(rng, b, 0.35 * LINEAR)) for a, b in lines]
    arcs = list(arcs)
    rng.shuffle(arcs)
    return lines, arcs


def arc_through(a, b, sagitta):
    """The counter-clockwise arc from a to b standing `sagitta` to the right of
    a -> b (bowing out of a counter-clockwise loop), as (start, end, centre).
    A negative sagitta bows it the other way, which is the arc from b to a."""
    cx, cy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    dx, dy = b[0] - a[0], b[1] - a[1]
    h = math.sqrt(dx * dx + dy * dy) / 2
    s = abs(sagitta)
    # Centre on the bisector, (h^2 - s^2) / (2 s) from the chord's middle
    # (h^2 + d^2 = r^2 with r = d + s), on the side away from the bow.
    d = (h * h - s * s) / (2 * s)
    nx, ny = dy / (2 * h), -dx / (2 * h)  # right-hand unit normal of a -> b
    if sagitta > 0:
        return (a, b, (cx - nx * d, cy - ny * d))
    return (b, a, (cx + nx * d, cy + ny * d))


def family_polygon(rng):
    pts = place(rng, polygon_points(rng, rng.random() < 0.7))
    return jumble(rng, ring(pts)) + ([],)


def family_broken(rng):
    lines, _, _ = family_polygon(rng)
    how = rng.randrange(5)
    lines = list(lines)
    if how == 0 and len(lines) > 1:
        lines.pop(rng.randrange(len(lines)))
    elif how == 1:
        a = rng.choice(lines)[0]
        lines.insert(rng.randrange(len(lines) + 1), (a, (a[0] + 3.5, a[1] - 2.25)))
    elif how == 2:
        lines.append(rng.choice(lines))
    elif how == 3:
        x0 = max(abs(v) for l in lines for p in l for v in p) * 2 + 10
        lines += [((x0, 0.0), (x0 + 5, 0.0)), ((x0 + 5, 0.0), (x0, 5.0)), ((x0, 5.0), (x0, 0.0))]
    else:
        return lines, [((1e6, 1e6), 2.0)], []
    return lines, [], []


def rot(p, k):
    """Turn p by the angle with cos 3/5, sin 4/5, k times (so tests are not all axis-aligned)."""
    for _ in range(k):
        p = (0.6 * p[0] - 0.8 * p[1], 0.8 * p[0] + 0.6 * p[1])
    return p


def family_boundary(rng):
    """A threshold case at 0.9x or 1.1x, with the answer worked out by hand
    from how it is built (the fourth item: the kind the kernel must give),
    so these are checked against the construction as well as the model."""
    f = rng.choice([0.9, 1.1])
    k = rng.randrange(3)
    which = rng.randrange(12)
    shift = rng.choice([0.0, 0.0, 1000.0, -37.5, 1e5])
    m = f * MIN_FEATURE
    lo = f < 1

    def at(pts):
        return [(x + shift, y + shift) for x, y in (rot(p, k) for p in pts)]

    def shuffled(pts, expect):
        lines, arcs = jumble(rng, ring(at(pts)), nudged=False)
        return lines, [], arcs, expect

    if which == 0:
        # A 10 mm square with one join f LINEAR apart: joined at 0.9,
        # a loose end at 1.1 (the turns by 3-4-5 keep the gap's length).
        lines = ring(at([(0, 0), (10, 0), (10, 10), (0, 10)]))
        a, b = lines[0]
        t = rng.random() * 2 * math.pi
        lines[0] = (a, (b[0] + f * LINEAR * math.cos(t), b[1] + f * LINEAR * math.sin(t)))
        return lines, [], [], "closed" if lo else "loose"
    if which == 1:
        # A line f MIN_FEATURE long, alone: too short at 0.9; at 1.1 a line
        # with two loose ends.
        a = at([(0, 0)])[0]
        return [(a, (a[0] + m, a[1]))], [], [], "error" if lo else "loose"
    if which == 2:
        # A square with a fifth corner (5, m) pushed up from the top side
        # (10, 10) -> (0, 10) down to m above the bottom side, which it does
        # not touch: m from it, so too close at 0.9, clear at 1.1 (every
        # other gap is at least 5 / sqrt(26) ~ 1 mm).
        return shuffled([(0, 0), (10, 0), (10, 10), (5, m), (0, 10)], "not a profile" if lo else "closed")
    if which == 3:
        # A thin wedge: (-5, 0) -> (10, 0) -> (0, m) -> (-5, 5). The corner
        # (0, m) stands straight above the point (0, 0) of the first side,
        # so it is m from it, both from that side's neighbour (the sides
        # meet at (10, 0) at an angle of about m / 10) and from the third
        # side, which starts there. Every other end is at least 5 mm from
        # every other side: (-5, 0) is past the end (0, m) of the second
        # side (its projection is 1.5 of the way along), so sqrt(25 + m^2)
        # from it. Too close at 0.9, clear at 1.1.
        return shuffled([(-5, 0), (10, 0), (0, m), (-5, 5)], "not a profile" if lo else "closed")
    if which == 4:
        # A circle of radius f MIN_FEATURE (too small at 0.9) or f MAX_SIZE / 2
        # (too big at 1.1), alone: otherwise its own outline.
        small = rng.random() < 0.5
        r = m if small else f * MAX_SIZE / 2
        return [], [((shift, shift), r)], [], ("error" if lo else "circle") if small else ("circle" if lo else "error")
    if which == 5:
        # Four sides, each about 0.55 MAX_SIZE long, spanning f MAX_SIZE in x:
        # within the span at 0.9, over it at 1.1.
        w = f * MAX_SIZE
        return ring([(0.0, 0.0), (w / 2, 1.0), (w, 0.0), (w / 2, -1.0)]), [], [], "closed" if lo else "not a profile"
    if which == 6:
        # A 5 mm line with an end at f MAX_COORD: a loose line at 0.9, out
        # of range at 1.1.
        return [((f * MAX_COORD, 0.0), (f * MAX_COORD - 5.0, 0.0))], [], [], "loose" if lo else "error"
    if which == 7:
        # A D: the line (10, 0) -> (0, 0) and an arc back bowing 3 below it,
        # its centre moved f LINEAR along the chord, which is that far off
        # the ends' bisector: allowed at 0.9, refused at 1.1.
        a, b, c = arc_through((0.0, 0.0), (10.0, 0.0), 3.0)
        return [((10.0, 0.0), (0.0, 0.0))], [], [(a, b, (c[0] + f * LINEAR, c[1]))], "closed" if lo else "error"
    if which == 8:
        # Out 10 along +x and straight back to 5: a cusp at (10, 0), whatever f.
        return shuffled([(0, 0), (10, 0), (5, 0), (5, 5)], "not a profile")
    if which == 9:
        # A corner where the outline goes straight on, (5, 0): fine.
        return shuffled([(0, 0), (5, 0), (10, 0), (10, 10), (0, 10)], "closed")
    if which == 10:
        # A 10 x 3 rectangle whose top bows down (in) by 3 - m: its lowest
        # point is m above the bottom side, the one piece it is not joined
        # to (near-tangent): too close at 0.9, clear at 1.1.
        pts = at([(0, 0), (10, 0), (10, 3), (0, 3)])
        top = arc_through(pts[2], pts[3], -(3 - m))
        lines, arcs = jumble(rng, ring(pts)[:2] + ring(pts)[3:], [top], nudged=False)
        return lines, [], arcs, "not a profile" if lo else "closed"
    # A 10 x 6 rectangle whose bottom bows up by 2.5 and top bows down by
    # 3.5 - m: the two arcs' nearest points, (5, 2.5) and (5, 2.5 + m), are m
    # apart: too close at 0.9, clear at 1.1.
    pts = at([(0, 0), (10, 0), (10, 6), (0, 6)])
    arcs = [arc_through(pts[0], pts[1], -2.5), arc_through(pts[2], pts[3], -(3.5 - m))]
    lines, arcs = jumble(rng, [ring(pts)[1], ring(pts)[3]], arcs, nudged=False)
    return lines, [], arcs, "not a profile" if lo else "closed"


def family_arcs(rng):
    shape = rng.randrange(4)
    unit = rng.choice([1.0, 0.1, 10.0, 0.01, 1000.0])
    o = rng.choice([0.0, 0.0, 500.0, 1e5])
    p = lambda x, y: (o + x * unit, o + y * unit)  # noqa: E731
    if shape == 0:  # a rectangle, some sides bowed
        pts = [p(0, 0), p(8, 0), p(8, 5), p(0, 5)]
    elif shape == 1:  # a triangle
        pts = [p(0, 0), p(7, 1), p(2, 6)]
    elif shape == 2:  # a D: one line and an arc back
        a, b = p(0, 0), p(6, 0)
        line = (a, b)
        arc = arc_through(b, a, rng.choice([1.0, 3.0, 5.0, -1.0]) * unit)
        lines, arcs = jumble(rng, [line], [arc])
        return family_arc_breaks(rng, lines, arcs)
    else:  # a lens: two arcs
        a, b = p(0, 0), p(6, 0)
        arcs = [arc_through(a, b, rng.choice([1.0, 2.0]) * unit), arc_through(b, a, rng.choice([1.0, 2.5]) * unit)]
        lines, arcs = jumble(rng, [], arcs)
        return family_arc_breaks(rng, lines, arcs)
    lines, arcs = [], []
    for a, b in ring(pts):
        roll = rng.random()
        if roll < 0.5:
            lines.append((a, b))
        else:
            # Bow out (positive) or in, by up to a third of the side.
            side = math.dist(a, b)
            arcs.append(arc_through(a, b, rng.choice([1, -1]) * side * rng.choice([0.05, 0.2, 0.33, 0.5])))
    lines, arcs = jumble(rng, lines, arcs, nudged=False)
    return family_arc_breaks(rng, lines, arcs)


def family_arc_breaks(rng, lines, arcs):
    roll = rng.randrange(6)
    if roll == 0 and arcs:
        arcs = arcs[1:]
    elif roll == 1 and arcs:
        arcs = arcs + [arcs[0]]
    elif roll == 2:
        lines = lines + [((-1e5, -1e5), (-1e5 + 3, -1e5))]
    return lines, [], arcs


def family_circles(rng):
    n = rng.choice([0, 1, 1, 2, 3])
    circles = [((rng.randint(-100, 100) * 1.5, rng.randint(-100, 100) * 0.25), rng.choice([0.5, 3.0, 1e-3 * 1.5, 1e4])) for _ in range(n)]
    lines = []
    if rng.random() < 0.4:
        lines, _, _ = family_polygon(rng)
    return lines, circles, []


FAMILIES = [family_polygon] * 4 + [family_broken] * 2 + [family_boundary] * 2 + [family_arcs] * 2 + [family_circles]


def sketch(seed):
    """Seed's sketch, (lines, circles, arcs), and the kind of answer its
    construction calls for (boundary cases), else None."""
    rng = random.Random(seed)
    made = rng.choice(FAMILIES)(rng)
    return (made[:3], made[3]) if len(made) == 4 else (made, None)


def bits(*xs):
    return [struct.unpack("<Q", struct.pack("<d", float(x)))[0] for x in xs]


def to_bits_json(lines, circles, arcs):
    """The runner's input: every double as its 64 bits (see sketch_outline_json.rs)."""
    return json.dumps({
        "lines": [bits(*a, *b) for a, b in lines],
        "circles": [bits(*c, r) for c, r in circles],
        "arcs": [bits(*s, *e, *c) for s, e, c in arcs],
    })


def to_json(lines, circles, arcs):
    """A sketch as the app sends it, for people to read and keep."""
    return json.dumps({
        "lines": [{"a": list(a), "b": list(b)} for a, b in lines],
        "circles": [{"centre": list(c), "radius": r} for c, r in circles],
        "arcs": [{"start": list(s), "end": list(e), "centre": list(c)} for s, e, c in arcs],
    })


# ---- the kernel's answers, in the model's terms -------------------------------

NUM = r"(-?[0-9.e+-]+|NaN|inf|-inf)"


def kernel_answers(cases):
    """Run every sketch through the kernel's JSON runner; one answer per case."""
    text = "".join(to_bits_json(*c) + "\n" for c in cases)
    run = subprocess.run(["cargo", "run", "-q", "--example", "sketch_outline_json"], cwd=KERNEL, input=text,
                         capture_output=True, text=True, check=True)
    return [json.loads(line) for line in run.stdout.splitlines()]


def read(answer):
    """The kernel's answer as the model's dict."""
    import re
    if "err" in answer:
        (inp,) = answer["err"]["inputs"] or [{"input": "sketch"}]
        return {"kind": "error", "input": (inp["input"], inp.get("index"))}
    ok = answer["ok"]
    if "closed" in ok:
        p = ok["closed"]
        pieces = [(x["curve"], x["index"], x["reversed"]) for x in p["pieces"]]
        if "circle" in p["outer"]:
            c = p["outer"]["circle"]
            return {"kind": "circle", "centre": tuple(c["center"]), "radius": c["radius"], "pieces": pieces}
        path = p["outer"]["path"]
        cs = path["corners"]
        return {"kind": "closed", "corners": [(cs[i], cs[i + 1]) for i in range(0, len(cs), 2)], "bulges": path["bulges"], "pieces": pieces}
    why = ok["open"]
    if "no lines, arcs or circles" in why:
        return {"kind": "empty"}
    m = re.match(r"the end at \((.*), (.*)\) is not joined", why)
    if m:
        return {"kind": "loose", "at": (float(m[1]), float(m[2]))}
    m = re.match(r"(\d+) ends meet at \((.*), (.*)\);", why)
    if m:
        return {"kind": "branch", "at": (float(m[2]), float(m[3])), "ends": int(m[1])}
    m = re.match(r"the sketch makes (\d+) separate loops", why)
    if m:
        return {"kind": "loops", "loops": int(m[1])}
    if "not a valid outline" in why:
        return {"kind": "not a profile", "curves": [(x["input"], x["index"]) for x in ok["invalid"]], "why": why}
    raise ValueError(f"unknown answer {answer}")


def same(want, got):
    """Whether the kernel's answer (got) is the model's (want); a reason when not."""
    if want["kind"] == "arcs":
        if got["kind"] == "not a profile":
            # The fault the kernel names must be one measuring finds.
            named = sorted(k for k, s in enumerate(want["pieces"]) if s[:2] in [tuple(c) for c in got["curves"]])
            faults = model.arc_loop_faults(want["corners"], want["bulges"], strict=False)
            if any(sorted(f[1:3]) == named or (f[0] == "short" and named == [f[1]]) for f in faults):
                return None
            return f"kernel refused an arc loop naming pieces {named} ({got['why']}); measuring finds {faults}"
        if got["kind"] != "closed":
            return f"model: a loop with arcs; kernel: {got['kind']}"
        want = dict(want, kind="closed")
        if [tuple(c) for c in got["corners"]] != [tuple(c) for c in want["corners"]] or got["pieces"] != want["pieces"]:
            return f"corners or pieces differ: model {want['corners']} {want['pieces']}, kernel {got['corners']} {got['pieces']}"
        if len(got["bulges"]) != len(want["bulges"]) or any(
                abs(g - w) > 1e-9 * max(1.0, abs(w)) for g, w in zip(got["bulges"], want["bulges"])):
            return f"bulges differ: model {want['bulges']}, kernel {got['bulges']}"
        faults = model.arc_loop_faults(got["corners"], got["bulges"], strict=True)
        if faults:
            return f"kernel accepted an arc loop with faults {faults}"
        return None
    if want["kind"] != got["kind"]:
        return f"model: {want}; kernel: {got}"
    for key in want:
        w, g = want[key], got.get(key)
        if key == "corners":
            w, g = [tuple(c) for c in w], [tuple(c) for c in g]
        elif key in ("at", "centre"):
            w, g = tuple(w), tuple(g)
        elif key == "curves":
            w, g = [tuple(c) for c in w], [tuple(c) for c in g]
        if w != g:
            return f"{key}: model {want[key]!r}, kernel {got.get(key)!r}"
    return None


def run(seeds, first=1, plant=None):
    """Check `seeds` sketches from seed `first`. Returns (counts, disagreements).
    `plant` changes the model's answer, to prove a wrong one is caught."""
    made = [sketch(s) for s in range(first, first + seeds)]
    cases = [case for case, _ in made]
    answers = kernel_answers(cases)
    counts, bad = {}, []
    for seed, (case, expect), answer in zip(range(first, first + seeds), made, answers):
        got = read(answer)
        if expect:
            counts["boundary: " + expect] = counts.get("boundary: " + expect, 0) + 1
            if got["kind"] != expect:
                bad.append((seed, case, f"built to be {expect}, the kernel says {got}"))
        try:
            want = model.outline(*case)
        except model.Ambiguous:
            counts["too close to call"] = counts.get("too close to call", 0) + 1
            continue
        if plant:
            want = plant(want)
        why = same(want, got)
        label = want["kind"] if want["kind"] != "arcs" else "arcs, " + ("refused" if got["kind"] == "not a profile" else "accepted")
        counts[label] = counts.get(label, 0) + 1
        if why:
            bad.append((seed, case, why))
    return counts, bad


def main():
    seeds = int(sys.argv[1]) if len(sys.argv) > 1 else 10000
    first = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    counts, bad = run(seeds, first)
    for k in sorted(counts):
        print(f"{k:40} {counts[k]}")
    for seed, case, why in bad[:20]:
        print(f"DISAGREE seed {seed}: {why}\n  {to_json(*case)}")
    print(f"{seeds} sketches, {len(bad)} disagreements")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
