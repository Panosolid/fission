"""An independent model of the kernel's sketch_outline (kernel/src/sketch.rs),
to check it on random sketches (testing hunt 3b, sketch_outline_check.py).

Written from the rules in the module comments of kernel/src/sketch.rs and
check_profile in kernel/src/ops/profile.rs, not from the code: every
straight-line test is exact, in fractions of the very doubles the kernel is
given (Fraction(float) is exact), and squared lengths stand in for lengths,
so no square root is ever rounded. The kernel works in doubles, so where a
value lands within a few roundings of a threshold the two can honestly
disagree; the model says so (`ambiguous`) instead of guessing, and the
checker leaves such cases out and counts them.

What the model decides:
- The sketch rules (check_lines, check_circles, check_arcs) and the first
  curve that breaks them.
- Joining ends (within LINEAR), loose ends and branches at the
  lowest-numbered end, the loop count with circles, the walk from piece 0,
  each corner's pick (the end of the piece with the larger |bulge|, else of
  the piece entered), the bulge signs and the source of each piece.
- For loops of straight lines, every profile rule check_profile applies,
  in its order: at least 3 corners, every side at least MIN_FEATURE, the
  span at most MAX_SIZE, no cusp (doubling back within ANGULAR), and every
  two sides at least MIN_FEATURE apart away from the corner they share;
  then the sides it names.
- A loop with arcs is walked and its corners, bulges and sources predicted,
  but its profile rules are not modelled (arc clearance has no exact
  rational form): the checker compares it only when the kernel accepts it.

Usage: from sketch_outline import outline; outline(lines, circles, arcs)
with lines [((ax, ay), (bx, by)), ...], circles [((cx, cy), r), ...] and
arcs [((sx, sy), (ex, ey), (cx, cy)), ...], plain floats.
"""

import math
from fractions import Fraction as F

# The kernel's constants (kernel/src/tolerance.rs), as the doubles it uses.
LINEAR = 1e-5
MIN_FEATURE = 1e-3
MAX_SIZE = 1e6
MAX_COORD = 1e8
ANGULAR = 1e-9
MAX_PROFILE_CORNERS = 2000

# Between equal |bulge|s a corner is the end of the piece entered. Only the
# deliberate-break test turns this off (test_sketch_outline.py).
PICK_ENTERED = True

# How close to a threshold a double computation may land and still go
# either way: about 4,500 roundings of one operation, relative to the
# threshold or to the lengths the kernel's sum works with (`scale`): the
# difference of two doubles is rounded relative to itself, so a length or
# gap carries no error from how far out its points are.
SLACK = 1e-12


class Ambiguous(Exception):
    """A decision within SLACK of its threshold: the kernel's doubles may go either way."""


def near(value, threshold, scale=0.0):
    """Raise Ambiguous when value is within SLACK (relative, also to scale) of threshold."""
    if abs(float(value) - float(threshold)) <= SLACK * max(abs(float(threshold)), abs(float(scale))):
        raise Ambiguous(f"{float(value)!r} is within rounding of {float(threshold)!r}")


def fr(p):
    return (F(p[0]), F(p[1]))


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def d2(a, b):
    d = sub(a, b)
    return dot(d, d)


def in_range(p):
    return all(math.isfinite(v) and abs(v) <= MAX_COORD for v in p)


def compare_len2(len2, limit, scale=0.0):
    """Sign of sqrt(len2) - limit, exactly, after an ambiguity check (scale: the size of the numbers involved)."""
    lim2 = F(limit) ** 2
    near(math.sqrt(float(len2)), limit, scale)
    return (len2 > lim2) - (len2 < lim2)


def seg_point_d2(a, b, p):
    """Exact squared distance from p to the segment ab (a != b)."""
    ab, ap = sub(b, a), sub(p, a)
    t = dot(ap, ab)
    if t <= 0:
        return dot(ap, ap)
    L = dot(ab, ab)
    if t >= L:
        return d2(p, b)
    c = cross(ab, ap)
    return c * c / L


def orient(a, b, c):
    v = cross(sub(b, a), sub(c, a))
    return (v > 0) - (v < 0)


def on_segment(a, b, p):
    return min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])


def segments_meet(a, b, c, d):
    """Whether the closed segments ab and cd share a point (exact)."""
    o1, o2, o3, o4 = orient(c, d, a), orient(c, d, b), orient(a, b, c), orient(a, b, d)
    if o1 * o2 < 0 and o3 * o4 < 0:
        return True
    return ((o1 == 0 and on_segment(c, d, a)) or (o2 == 0 and on_segment(c, d, b))
            or (o3 == 0 and on_segment(a, b, c)) or (o4 == 0 and on_segment(a, b, d)))


def arc_bulge(start, end, centre):
    """tan(phi/4) for the counter-clockwise angle phi from start to end round centre.

    From the angle, not the sagitta the kernel uses (Arc::bulge), so the two
    routes check each other: phi = atan2(u x v, u . v) for u, v the ends
    seen from the centre, moved into (0, 2 pi]."""
    u = (start[0] - centre[0], start[1] - centre[1])
    v = (end[0] - centre[0], end[1] - centre[1])
    phi = math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])
    if phi <= 0:
        phi += 2 * math.pi
    return math.tan(phi / 4)


def check_lines(lines):
    if len(lines) > MAX_PROFILE_CORNERS:
        return ("sketch", None)
    for i, (a, b) in enumerate(lines):
        if not in_range(a) or not in_range(b):
            return ("line", i)
        L2 = d2(fr(a), fr(b))
        if compare_len2(L2, MIN_FEATURE) < 0 or compare_len2(L2, MAX_SIZE) > 0:
            return ("line", i)
    return None


def check_circles(circles):
    for i, (c, r) in enumerate(circles):
        near(r, MIN_FEATURE)
        near(r, MAX_SIZE / 2)
        if not (MIN_FEATURE <= r <= MAX_SIZE / 2):
            return ("circle", i)
        for v in c:
            near(abs(v) + r, MAX_COORD)
        if not all(math.isfinite(v) and abs(v) + r <= MAX_COORD for v in c):
            return ("circle", i)
    return None


def check_arcs(arcs):
    for i, (s, e, c) in enumerate(arcs):
        if not (in_range(s) and in_range(e) and in_range(c)):
            return ("arc", i)
        S, E, C = fr(s), fr(e), fr(c)
        chord2 = d2(S, E)
        if compare_len2(chord2, MIN_FEATURE) < 0:
            return ("arc", i)
        # The sums below work with lengths about the radius.
        scale = math.dist(s, c) + math.dist(e, c)
        # The centre's distance from the ends' perpendicular bisector:
        # (C - M) . (E - S) / |E - S|, M the midpoint; squared, exactly.
        M = ((S[0] + E[0]) / 2, (S[1] + E[1]) / 2)
        off = dot(sub(C, M), sub(E, S))
        if compare_len2(off * off / chord2, LINEAR, scale) > 0:
            return ("arc", i)
        r = (math.dist(s, c) + math.dist(e, c)) / 2
        near(r, MIN_FEATURE, scale)
        near(r, MAX_SIZE, scale)
        if not (MIN_FEATURE <= r <= MAX_SIZE):
            return ("arc", i)
        # The arc's reach: its ends, and the circle's axis extremes it passes.
        phi0 = math.atan2(s[1] - c[1], s[0] - c[0])
        sweep = 4 * math.atan(arc_bulge(s, e, c))
        reach = [abs(v) for v in (*s, *e)]
        for k in range(4):
            t = (k * math.pi / 2 - phi0) % (2 * math.pi)
            if t <= sweep:
                p = (c[0] + r * math.cos(k * math.pi / 2), c[1] + r * math.sin(k * math.pi / 2))
                reach += [abs(p[0]), abs(p[1])]
        for v in reach:
            near(v, MAX_COORD)
        if max(reach) > MAX_COORD:
            return ("arc", i)
    return None


def outline(lines, circles=(), arcs=()):
    """What the sketch makes, as a dict with "kind":

    error (with "input": (curve, index)), empty, loose ("at"), branch
    ("at", "ends"), loops ("loops"), not a profile ("curves": the
    (curve, index) pairs named), closed ("corners", "bulges", "pieces":
    (curve, index, reversed) per piece) or, for a loop with arcs,
    arcs ("corners", "bulges", "pieces" as closed would have them).
    Raises Ambiguous when a decision is too close to call in doubles."""
    lines, circles, arcs = list(lines), list(circles), list(arcs)
    if len(lines) + len(circles) + len(arcs) > MAX_PROFILE_CORNERS:
        return {"kind": "error", "input": ("sketch", None)}
    for check, items in ((check_lines, lines), (check_circles, circles), (check_arcs, arcs)):
        bad = check(items)
        if bad:
            return {"kind": "error", "input": bad}
    # Pieces: lines first, then arcs; end 2i is piece i's start, 2i + 1 its end.
    pieces = [(a, b, 0.0) for a, b in lines] + [(s, e, arc_bulge(s, e, c)) for s, e, c in arcs]
    if not pieces:
        if not circles:
            return {"kind": "empty"}
        if len(circles) == 1:
            (c, r), = circles
            return {"kind": "circle", "centre": c, "radius": r, "pieces": [("circle", 0, False)]}
        return {"kind": "loops", "loops": len(circles)}
    ends = [p for a, b, _ in pieces for p in (a, b)]
    exact = [fr(p) for p in ends]
    near_ends = [[] for _ in ends]
    for i in range(len(ends)):
        for j in range(i + 1, len(ends)):
            gap2 = d2(exact[i], exact[j])
            # Only ends within a few LINEAR need the careful look.
            if gap2 <= F(4 * LINEAR) ** 2 and compare_len2(gap2, LINEAR) <= 0:
                near_ends[i].append(j)
                near_ends[j].append(i)
    for e, others in enumerate(near_ends):
        if not others:
            return {"kind": "loose", "at": ends[e]}
        if len(others) > 1:
            return {"kind": "branch", "at": ends[e], "ends": len(others) + 1}
    partner = [o[0] for o in near_ends]
    walk, bulges, seen = [], [], [False] * len(pieces)
    piece, entered = 0, 0
    while not seen[piece]:
        seen[piece] = True
        walk.append(2 * piece + entered)
        b = pieces[piece][2]
        bulges.append(b if entered == 0 else -b)
        nxt = partner[2 * piece + 1 - entered]
        piece, entered = nxt // 2, nxt % 2
    loops = 1 + len(circles)
    for start in range(len(pieces)):
        if seen[start]:
            continue
        loops += 1
        piece, entered = start, 0
        while not seen[piece]:
            seen[piece] = True
            nxt = partner[2 * piece + 1 - entered]
            piece, entered = nxt // 2, nxt % 2
    if loops > 1:
        return {"kind": "loops", "loops": loops}
    corners = []
    for e in walk:
        came = partner[e]
        bc, be = abs(pieces[came // 2][2]), abs(pieces[e // 2][2])
        # Two arcs bulging alike: the kernel's pick may go either way, which
        # matters only when the two ends are not the same point.
        if bc and be and ends[came] != ends[e]:
            near(bc, be)
        corners.append(ends[came] if bc > be or (bc == be and not PICK_ENTERED) else ends[e])
    sources = [("line", e // 2, e % 2 == 1) if e // 2 < len(lines) else ("arc", e // 2 - len(lines), e % 2 == 1) for e in walk]
    if any(bulges):
        return {"kind": "arcs", "corners": corners, "bulges": bulges, "pieces": sources}
    why = polygon_rules(corners)
    if why is not None:
        return {"kind": "not a profile", "curves": [sources[k][:2] for k in why]}
    return {"kind": "closed", "corners": corners, "bulges": [], "pieces": sources}


def polygon_rules(corners):
    """check_profile's rules for one loop of straight sides, in its order:
    None when they all hold, else the sides (side i runs from corner i to
    corner i + 1) the first broken rule names."""
    n = len(corners)
    if n < 3:
        return []
    P = [fr(p) for p in corners]
    for i in range(n):
        if compare_len2(d2(P[i], P[(i + 1) % n]), MIN_FEATURE) < 0:
            return [i]
    for axis in (0, 1):
        span = max(p[axis] for p in P) - min(p[axis] for p in P)
        near(span, MAX_SIZE)
        if span > MAX_SIZE:
            return []
    # A cusp: arriving along a, leaving along b, with a . b < 0 and
    # |a x b| <= ANGULAR |a| |b| (unit tangents' cross product), squared.
    for i in range(n):
        a, b = sub(P[(i + 1) % n], P[i]), sub(P[(i + 2) % n], P[(i + 1) % n])
        if dot(a, b) < 0:
            c2, lim2 = cross(a, b) ** 2, F(ANGULAR) ** 2 * dot(a, a) * dot(b, b)
            if lim2:
                near(math.sqrt(float(c2 / lim2)), 1.0)
            if c2 <= lim2:
                return [i, (i + 1) % n]
    # A distance from an end to a side is worked from the side's own length.
    scale = max(math.dist(corners[i], corners[(i + 1) % n]) for i in range(n))
    # Clearance: sides that share a corner are measured from each one's far
    # end to the other (the shared corner is where they meet); other sides
    # touching or crossing are 0 apart, else the least end-to-side distance.
    for i in range(n):
        for j in range(i + 1, n):
            a, b, c, d = P[i], P[(i + 1) % n], P[j], P[(j + 1) % n]
            shared = []
            if (i + 1) % n == j:
                shared.append(b)
            if (j + 1) % n == i:
                shared.append(d)
            if not shared and segments_meet(a, b, c, d):
                return [i, j]
            lin2 = F(LINEAR) ** 2
            cands = [seg_point_d2(c, d, x) for x in (a, b) if all(d2(x, s) > lin2 for s in shared)]
            cands += [seg_point_d2(a, b, x) for x in (c, d) if all(d2(x, s) > lin2 for s in shared)]
            if cands and compare_len2(min(cands), MIN_FEATURE, scale) < 0:
                return [i, j]
    return None


# ---- loops with arcs: faults found by measuring --------------------------------
#
# Arc clearance has no exact rational form, so for loops with arcs the
# model measures in doubles instead and only ever claims what a measured
# point proves: two pieces are closer than MIN_FEATURE when it finds a
# point of one that close to the other (a distance can only be
# over-estimated by sampling, never under), and a corner is a cusp when
# its two tangents point opposite ways. The checker uses these both ways:
# a loop the kernel refuses must have the fault it names found here, and a
# loop the kernel accepts must have none found here.


def piece_geometry(a, b, bulge):
    """A piece from corner a to b with the given bulge: ("line", a, b) or
    ("arc", a, b, centre, radius, start angle, sweep).

    From the bulge beta = tan(sweep / 4) and the chord c: the sagitta (how
    far the arc's middle stands off the chord's middle, to the right of
    a -> b for beta > 0) is s = beta c / 2, the radius r = c (1 + beta^2) /
    (4 |beta|) (from r^2 = (c/2)^2 + (r - |s|)^2), and the centre is
    r - |s| beyond the chord's middle on the side away from the arc."""
    if bulge == 0:
        return ("line", a, b)
    dx, dy = b[0] - a[0], b[1] - a[1]
    c = math.hypot(dx, dy)
    rn = (dy / c, -dx / c)
    s = bulge * c / 2
    r = c * (1 + bulge * bulge) / (4 * abs(bulge))
    k = s - math.copysign(r, bulge)
    centre = ((a[0] + b[0]) / 2 + rn[0] * k, (a[1] + b[1]) / 2 + rn[1] * k)
    return ("arc", a, b, centre, r, math.atan2(a[1] - centre[1], a[0] - centre[0]), 4 * math.atan(bulge))


def point_on(g, t):
    if g[0] == "line":
        return (g[1][0] + t * (g[2][0] - g[1][0]), g[1][1] + t * (g[2][1] - g[1][1]))
    _, _, _, c, r, th, sw = g
    return (c[0] + r * math.cos(th + t * sw), c[1] + r * math.sin(th + t * sw))


def distance_to(g, p):
    """Distance from p to the piece, as near exact as doubles allow."""
    if g[0] == "line":
        return math.sqrt(float(seg_point_d2(fr(g[1]), fr(g[2]), fr(p)))) if g[1] != g[2] else math.dist(p, g[1])
    _, a, b, c, r, th, sw = g
    ang = math.atan2(p[1] - c[1], p[0] - c[0])
    rel = (ang - th) % (2 * math.pi) if sw > 0 else (th - ang) % (2 * math.pi)
    if rel <= abs(sw):
        return abs(math.dist(p, c) - r)
    return min(math.dist(p, a), math.dist(p, b))


def tangents(g):
    """Unit tangents at the piece's start and end, in its direction."""
    if g[0] == "line":
        d = math.dist(g[1], g[2])
        u = ((g[2][0] - g[1][0]) / d, (g[2][1] - g[1][1]) / d)
        return u, u
    _, _, _, _, _, th, sw = g
    sign = 1 if sw > 0 else -1
    at = lambda t: (-math.sin(t) * sign, math.cos(t) * sign)  # noqa: E731
    return at(th), at(th + sw)


def least_gap(g, h, keep_away=()):
    """An upper bound on how close pieces g and h come, from points of each
    (sampled, then refined round the best) measured to the other; points
    within `MIN_FEATURE` of a corner in keep_away (where they meet) don't count."""
    best = math.inf
    for u, v in ((g, h), (h, g)):
        ts = [k / 512 for k in range(513)]
        scored = []
        for t in ts:
            p = point_on(u, t)
            if all(math.dist(p, q) > MIN_FEATURE for q in keep_away):
                scored.append((distance_to(v, p), t))
        if not scored:
            continue
        d, t0 = min(scored)
        lo, hi = max(0.0, t0 - 1 / 512), min(1.0, t0 + 1 / 512)
        for _ in range(60):
            m1, m2 = lo + (hi - lo) / 3, hi - (hi - lo) / 3
            p1, p2 = point_on(u, m1), point_on(u, m2)
            f1 = distance_to(v, p1) if all(math.dist(p1, q) > MIN_FEATURE for q in keep_away) else math.inf
            f2 = distance_to(v, p2) if all(math.dist(p2, q) > MIN_FEATURE for q in keep_away) else math.inf
            d = min(d, f1, f2)
            if f1 < f2:
                hi = m2
            else:
                lo = m1
        best = min(best, d)
    return best


def arc_loop_faults(corners, bulges, strict):
    """The faults measuring finds in a loop with arcs: ("short", i),
    ("cusp", i, i + 1) and ("close", i, j, gap) for pieces i < j
    (neighbours measured away from their shared corner, and only when not
    strict). strict: report only what is plainly a fault (tangents
    opposite to 1e-11, a gap under 0.999 MIN_FEATURE: the kernel accepted
    this loop, so a fault found must be beyond any rounding); otherwise
    anything that would explain a refusal (to 1e-7, under MIN_FEATURE)."""
    n = len(corners)
    out = []
    for i in range(n):
        if math.dist(corners[i], corners[(i + 1) % n]) < MIN_FEATURE:
            out.append(("short", i))
    if out:
        return out
    gs = [piece_geometry(corners[i], corners[(i + 1) % n], bulges[i]) for i in range(n)]
    turn = 1e-11 if strict else 1e-7
    for i in range(n):
        t_in, t_out = tangents(gs[i])[1], tangents(gs[(i + 1) % n])[0]
        if t_in[0] * t_out[0] + t_in[1] * t_out[1] < 0 and abs(t_in[0] * t_out[1] - t_in[1] * t_out[0]) <= turn:
            out.append(("cusp", i, (i + 1) % n))
    limit = 0.999 * MIN_FEATURE if strict else MIN_FEATURE
    for i in range(n):
        for j in range(i + 1, n):
            shared = [corners[j]] if (i + 1) % n == j else []
            shared += [corners[i]] if (j + 1) % n == i else []
            # Neighbours come close by their shared corner by right; the
            # kernel measures them from their other points (strict mode
            # leaves them to it).
            if shared and strict:
                continue
            gap = least_gap(gs[i], gs[j], shared)
            if gap < limit:
                out.append(("close", i, j, gap))
    return out
