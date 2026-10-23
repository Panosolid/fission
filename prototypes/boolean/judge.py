"""The judge for step 30c's boolean fuzzing: is the kernel's answer right?

Each line (kernel/tests/support/boolean_cases.rs writes them) holds two
solids, an op and, from step 34 on, the kernel's `answer`: either its bodies
(each with volume, area, faces, edges, vertices, shells, box, and rings and
genus if it gives them) or an error and where it is:

    {"bodies": [{"volume": "1008.0", "area": "616.0", "faces": 11, ...,
                 "box": ["0.0", ..., "12.0"]}]}
    {"error": "nonmanifold", "where": [{"edge": [[x, y, z], [x, y, z]]},
                                       {"vertex": [x, y, z]}]}
    {"error": "thin", "where": [{"edge": [p, q]}, {"gap": [[p, q], [r, s]]}]}
    {"error": "empty"}    (or {"bodies": []}: an intersect of parts that only
                           touch returns no bodies, B0 decision 2)

Every number is a string: the shortest decimal that reads back as the
double, so the judge sees exactly the values the kernel was given and gave.

How it judges. The exact models (box_model.py for boxes, convex_model.py for
turned prisms) answer the same booleans with no rounding. First rule 1: two
places within 2·LINEAR (the sum of two default tolerances) are one place to
the kernel, which the models cannot see (they refuse such inputs), so the
judge snaps first, moving B onto A (A keeps its planes, as 35c's tidying
keeps A's plane):
- boxes: each of B's coordinates within 2·LINEAR of one of A's on the same
  axis becomes A's;
- prisms: B is moved by the one translation t that puts every corner of
  each on the other's planes where it is within 2·LINEAR of them, and every
  pair of crossing edges within 2·LINEAR through each other (keeping every
  exact contact), the shortest such t, exactly; near places that no single
  move of B brings together are beyond the judge (it says so, see Limits).
Then:
- the kernel's outcome must be one of the model's `problems` (any one, as
  box_model says), or bodies when there are none;
- counts exact (faces, edges, vertices, shells; rings and genus if given),
  bodies matched by box;
- volume and area within MASS_PROPS_REL of the model's, plus what the snap
  allows: the kernel's merged vertices may sit where either input put them,
  up to D from the model's (D = the snap distance; for a turned prism its
  vertices made with A's planes can move up to 3|t|/|det| for the least
  well-conditioned three planes), which moves volume by at most D times B's
  area and area by at most 8 D times B's edge length (to first order: each
  face on B's planes keeps within twice its own perimeter, and A's faces
  change only along edges they share with those);
- every place the kernel names in `where` within tolerance of one the model
  lists (within the cap on a vertex's tolerance, 10·LINEAR, plus D plus the
  rounding of where the place is), and for a non-manifold result every
  place the model lists named (decision 2);
- a length within its rounding (and 2D) of MIN_FEATURE may be judged thin or
  not by the kernel; both are right.

Limits (tracked, never passed): a line is "beyond the judge" when its near
places need more than one move of B (a prism within 2·LINEAR of A at both
its top and its bottom), and "on a band's edge" when a gap is within
rounding of 2·LINEAR itself (either answer is right); both are reported and
counted, never counted as agreeing. The generator makes neither.

Usage: python3 judge.py LINES [--model-answers] [--planted] [--occ]
  (no flag)        judge each line's `answer`
  --model-answers  answer each line from the models and judge that, and
                   check each line's `intent` (the generator's claim of what
                   the family gives) against the models: tests the generator
                   and the judge's own reading before the kernel can answer
  --planted        plant each kind of wrong answer (PLANTS) in each line it
                   applies to: every one must be caught
  --occ            also OpenCascade's own boolean on each snapped pair: it
                   must give the model's bodies (needs cadquery-ocp)
Exit 1 on any disagreement, line beyond the judge, wrong intent or missed
plant (and, with --model-answers, any line on a band's edge, which the
generator promises never to make).
"""

import json
import math
import os
import sys
from contextlib import contextmanager
from fractions import Fraction
from itertools import combinations

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import box_model  # noqa: E402
import convex_model  # noqa: E402
from box_model import LINEAR, MIN_FEATURE, SAME, ModelError  # noqa: E402
from convex_model import cross, dot, plus, point_segment2, sub, times  # noqa: E402

MASS_PROPS_REL = Fraction(1, 10**6)  # kernel/src/tolerance.rs
CAP = 10 * LINEAR  # B0 decision 5: no vertex or edge tolerance above it
ROUNDING_ULPS = 64  # tolerance.rs: rounding_slack
EPS = 2.0 ** -52


class Beyond(ModelError):
    """A line the judge cannot judge (see Limits)."""


class OnEdge(ModelError):
    """A gap within rounding of 2·LINEAR: either answer is right."""


def exact(s):
    """The exact value of a number written as a string."""
    if not isinstance(s, str):
        raise ModelError(f"number {s!r} is not written as a string")
    x = float(s)
    if not math.isfinite(x):
        raise ModelError(f"number {s!r} is not finite")
    return Fraction(x)


def point(xs):
    return tuple(exact(x) for x in xs)


def rounding(reach):
    return Fraction(ROUNDING_ULPS * EPS * max(1.0, float(reach)))


class Solid:
    """One solid of a line: `kind` "boxes" (world boxes) or "prism" (a
    convex_model.Prism), with its area, edge length and place."""

    def __init__(self, d):
        self.place = point(d["place"])
        if "boxes" in d:
            self.kind = "boxes"
            local = [point(b) for b in d["boxes"]]
            self.local_reach = max(abs(x) for b in local for x in b)
            self.boxes = [box_model.box(*(c + self.place[i % 3] for i, c in enumerate(b))) for b in local]
        else:
            self.kind = "prism"
            outline = [point(p) for p in d["outline"]]
            z = point(d["z"])
            rotation = convex_model.compose(*[convex_model.turn(axis, a, b, c) for axis, a, b, c in d["turns"]])
            given = [point(r) for r in d["matrix"]]
            for i in range(3):
                for j in range(3):
                    if abs(given[i][j] - rotation[i][j]) > 4 * EPS:
                        raise ModelError(f"the matrix is not its turns: {float(given[i][j])} for {rotation[i][j]}")
            self.prism = convex_model.Prism(outline, z[0], z[1], rotation, self.place)
            self.local_reach = max(abs(x) for p in outline for x in p) + max(abs(x) for x in z)

    def corners(self):
        if self.kind == "prism":
            return self.prism.vertices
        return [(b[0 + 3 * (i & 1)], b[1 + 3 * (i >> 1 & 1)], b[2 + 3 * (i >> 2 & 1)]) for b in self.boxes for i in range(8)]


class Want:
    """What the models say a line's answer must be, and how close is close
    enough: `result` (box_model's dict), `D` (the snap's reach), `slack`
    (volume, area), `tol` (for places and boxes), `thin_wide` (every thin
    place within the MIN_FEATURE band), `thin_either` (the band decides)."""


class Snap:
    """What snapping did: `D`, how far a vertex of the result may sit from
    the model's, and `volume`, `area`, how far the kernel's volume and area
    may then be from the model's (to first order; see the module comment)."""

    def __init__(self):
        self.D, self.volume, self.area = 0.0, 0.0, 0.0

    def plane(self, move, sin, area, perimeter):
        """One face of B (area, perimeter) moved `move` along its normal,
        meeting other planes at a sine of at least `sin`: its vertices slide
        move / sin; the volume changes by at most move times its area; the
        area along the result's edges on that plane, whose length is at most
        twice the face's perimeter (the result's face there lies in B's
        face), by at most move (1 + 1 / sin) per unit length."""
        self.D += move / sin
        self.volume += move * area
        self.area += 2 * perimeter * move * (1 + 1 / sin)


def snap_boxes(a, b, margin):
    """B's boxes with each coordinate within SAME of one of A's moved onto
    it (plane by plane: every face of a box meets the others square)."""
    snap = Snap()
    maps = []
    for axis in range(3):
        av = sorted({x[k] for x in a for k in (axis, axis + 3)})
        m = {}
        for y in sorted({x[k] for x in b for k in (axis, axis + 3)}):
            near = [x for x in av if abs(x - y) <= SAME]
            for x in av:
                if abs(abs(x - y) - SAME) <= margin:
                    raise OnEdge(f"{float(y)} and {float(x)} on {'xyz'[axis]} are within rounding of 2·LINEAR apart")
            if len(near) > 1:
                raise Beyond(f"{float(y)} on {'xyz'[axis]} is within tolerance of {len(near)} of A's coordinates")
            if near and near[0] != y:
                m[y] = near[0]
        maps.append(m)
    moved = [0.0, 0.0, 0.0]
    for x in b:
        w = [float(x[k + 3] - x[k]) for k in range(3)]
        for k in range(6):
            if x[k] in maps[k % 3]:
                move = float(abs(maps[k % 3][x[k]] - x[k]))
                u, v = [w[j] for j in range(3) if j != k % 3]
                snap.plane(move, 1.0, u * v, 2 * (u + v))
                moved[k % 3] = max(moved[k % 3], move)
    # A vertex moves along each axis at most once: D is the diagonal.
    snap.D = math.sqrt(sum(d * d for d in moved))
    out = [tuple(maps[k % 3].get(c, c) for k, c in enumerate(x)) for x in b]
    return out, snap


def prism_faces(p):
    """(normal, area, perimeter) of each face of a prism, in the order of
    its halfspaces (sides, then top and bottom)."""
    pts = p.outline
    sides = [math.sqrt(float((q[0] - r[0]) ** 2 + (q[1] - r[1]) ** 2)) for r, q in zip(pts, pts[1:] + pts[:1])]
    h = float(p.z[1] - p.z[0])
    cap = abs(sum(float(r[0] * q[1] - q[0] * r[1]) for r, q in zip(pts, pts[1:] + pts[:1]))) / 2
    out = [(p.halfspaces[i][0], sides[i] * h, 2 * (sides[i] + h)) for i in range(len(pts))]
    return out + [(p.halfspaces[-2][0], cap, sum(sides)), (p.halfspaces[-1][0], cap, sum(sides))]


def least_sine(n, planes):
    """The least sine between n and the planes not parallel to it."""
    sines = [math.sqrt(float(dot(cross(n, m), cross(n, m)))) for m in planes]
    return min(x for x in sines if x > 0)


def solve_rows(rows):
    """The shortest t with n . t = g for every (n, g), exactly, or None."""
    basis = []  # (n, g) kept independent, reduced copies for testing
    reduced = []
    for n, g in rows:
        v, h = list(n), g
        for (bn, bg), piv in reduced:
            if v[piv]:
                f = v[piv] / bn[piv]
                v = [x - f * y for x, y in zip(v, bn)]
                h -= f * bg
        if any(v):
            piv = next(i for i, x in enumerate(v) if x)
            reduced.append(((v, h), piv))
            basis.append((n, g))
        elif h:
            return None
    if not basis:
        return (Fraction(0),) * 3
    # t = N^T y with (N N^T) y = g.
    k = len(basis)
    gram = [[dot(basis[i][0], basis[j][0]) for j in range(k)] + [basis[i][1]] for i in range(k)]
    for c in range(k):
        p = next(r for r in range(c, k) if gram[r][c])
        gram[c], gram[p] = gram[p], gram[c]
        for r in range(k):
            if r != c and gram[r][c]:
                f = gram[r][c] / gram[c][c]
                gram[r] = [x - f * y for x, y in zip(gram[r], gram[c])]
    y = [gram[i][k] / gram[i][i] for i in range(k)]
    t = (Fraction(0),) * 3
    for yi, (n, _) in zip(y, basis):
        t = plus(t, times(yi, n))
    return t


def prism_rows(a, b, t, margin):
    """Every near place of A and B moved by t, as rows on B's move from
    where it was: corner on plane, and edges crossing through each other."""
    rows = []
    for s, o, sign in ((b, a, 1), (a, b, -1)):
        for v in s.vertices:
            v_now = plus(v, t) if sign > 0 else v
            for n, d in o.halfspaces:
                d_now = d if sign > 0 else d + dot(n, t)
                g = dot(n, v_now) - d_now
                if abs(abs(g) - SAME) <= margin:
                    raise OnEdge(f"corner {v} is within rounding of 2·LINEAR from a plane")
                if abs(g) <= SAME:
                    # B's corner on A's plane: n . (v + t') = d; A's corner on
                    # B's plane: n . v = d + n . t'.
                    rows.append((n, d - dot(n, v)) if sign > 0 else (n, dot(n, v) - d))
    for p0, p1 in b.segments():
        for q0, q1 in a.segments():
            p0n, p1n = plus(p0, t), plus(p1, t)
            u, v, w = sub(p1n, p0n), sub(q1, q0), sub(p0n, q0)
            m = cross(u, v)
            if not any(m):
                continue  # parallel: near only where a corner is, rows above
            aa, bb, cc, dd, ee = dot(u, u), dot(u, v), dot(v, v), dot(u, w), dot(v, w)
            den = aa * cc - bb * bb
            s_, t_ = (bb * ee - cc * dd) / den, (aa * ee - bb * dd) / den
            if not (0 < s_ < 1 and 0 < t_ < 1):
                continue  # closest at a corner: the corner rows hold it
            g2 = dot(m, w) ** 2 / dot(m, m)
            if g2 <= SAME * SAME:
                rows.append((m, -dot(m, sub(p0, q0))))
    return rows


def snap_caps(a, b, margin):
    """B with its top or bottom moved onto a plane of A parallel to it and
    within SAME (plane by plane, as for boxes; every family the generator
    makes near a band is of this kind), and what that did."""
    snap = Snap()
    planes = [n for n, _ in a.halfspaces + b.halfspaces]
    z = list(b.z)
    for which, (n, d) in zip((1, 0), b.halfspaces[-2:]):
        gaps = []
        for m, e in a.halfspaces:
            if m == n:
                gaps.append(e - d)
            elif m == times(-1, n):
                gaps.append(-e - d)
        gaps = [g for g in gaps if abs(g) <= SAME and g]
        if len(gaps) > 1:
            raise Beyond(f"B's {'top' if which else 'bottom'} is within tolerance of {len(gaps)} planes of A")
        if gaps:
            # Outward along n by the gap: the top up, the bottom down.
            z[which] += gaps[0] if which else -gaps[0]
            face = prism_faces(b)[-2 if which else -1]
            snap.plane(float(abs(gaps[0])), least_sine(n, planes), face[1], face[2])
    if z == list(b.z):
        return b, snap
    if not z[0] < z[1]:
        raise Beyond("B's top and bottom snapped onto one plane")
    return convex_model.Prism(b.outline, z[0], z[1], b.rotation, b.move), snap


def snap_prisms(a, b, margin):
    """B with every near place brought together: its top and bottom plane
    by plane (snap_caps), then any other near place by the shortest one move
    of all of B, and what that did."""
    prism_rows(a, b, (Fraction(0),) * 3, margin)  # the band's edge, even when nothing is near
    try:
        convex_model.refuse_close(a, b)
        return b, Snap()
    except ModelError:
        pass
    b, snap = snap_caps(a, b, margin)
    try:
        convex_model.refuse_close(a, b)
        return b, snap
    except ModelError:
        pass
    t = (Fraction(0),) * 3
    rows = []
    for _ in range(5):
        new = [r for r in prism_rows(a, b, t, margin) if r not in rows]
        if not new and rows:
            break
        rows += new
        t = solve_rows(rows)
        if t is None:
            raise Beyond("near places that no single move of B brings together")
    moved = convex_model.Prism(b.outline, *b.z, b.rotation, plus(b.move, t))
    try:
        convex_model.refuse_close(a, moved)
    except ModelError as e:
        raise Beyond(f"still near after the snap: {e}")
    # All of B moved by t: each face along its normal by n . t, its vertices
    # by |t|, and those made with A's planes by up to 3 |t| / |det| (three
    # planes, each moved at most |t|: the inverse of their unit normals is
    # at most sqrt(3) / |det| in size, times sqrt(3) |t|).
    normals = sorted({n for s in (a, b) for n, _ in s.halfspaces})
    det = min(d for d in (abs(dot(x, cross(y, z))) for x, y, z in combinations(normals, 3)) if d)
    size = math.sqrt(float(dot(t, t)))
    for n, area, perimeter in prism_faces(b):
        sin = least_sine(n, normals)
        snap.volume += float(abs(dot(n, t))) * area
        snap.area += 2 * perimeter * (float(abs(dot(n, t))) + size) / sin * 2
    snap.D += 3 * size / float(det)
    return moved, snap


@contextmanager
def min_feature(value):
    """Both models' thin rule at another MIN_FEATURE (for the band's edge)."""
    old = box_model.MIN_FEATURE, convex_model.MIN_FEATURE
    box_model.MIN_FEATURE = convex_model.MIN_FEATURE = value
    try:
        yield
    finally:
        box_model.MIN_FEATURE, convex_model.MIN_FEATURE = old


def want(line):
    """The models' answer to a line, with how close the kernel must come."""
    op = line["op"]
    if op not in box_model.OPS:
        raise ModelError(f"unknown op {op!r}")
    a, b = Solid(line["a"]), Solid(line["b"])
    if a.kind != b.kind:
        raise ModelError("boxes against a prism: write the box as a prism")
    shift = max(abs(x - y) for x, y in zip(a.place, b.place))
    margin = rounding(max(a.local_reach, b.local_reach) + shift)
    w = Want()
    if a.kind == "boxes":
        bb, snap = snap_boxes(a.boxes, b.boxes, margin)
        grid = box_model.Grid([a.boxes, bb])
        ca, cb = grid.cells(a.boxes), grid.cells(bb)
        box_model.check_input("A", grid, ca)
        box_model.check_input("B", grid, cb)
        cells = frozenset({"union": ca | cb, "subtract": ca - cb, "intersect": ca & cb}[op])
        w.result = box_model.judge_cells(grid, cells)
        m = box_model.Measured(grid, cells)
        thin_ok = bool(cells) and not m.nonmanifold
        w.inputs = ("boxes", a.boxes, bb, a.place)
        w.fill = lambda: box_model.judge_cells(grid, ca | cb)
        w.alone = lambda: box_model.solid(a.boxes)
    else:
        bp, snap = snap_prisms(a.prism, b.prism, margin)
        convex_model.check_input("A", a.prism)
        convex_model.check_input("B", bp)
        m = convex_model.Measured([a.prism, bp], convex_model.INSIDE[op])
        w.result = convex_model.judge(m, not m.faces)
        thin_ok = bool(m.faces) and not m.nonmanifold
        w.inputs = ("prism", a.prism, bp, a.place)
        w.fill = lambda: convex_model.boolean("union", a.prism, bp)
        w.alone = lambda: convex_model.solid(a.prism)
    reach = max(abs(x) for s in (a, b) for c in s.corners() for x in c)
    w.reach, w.D = reach, snap.D
    band = Fraction(2 * w.D) + rounding(reach)
    w.thin_wide, w.thin_either = [], False
    if thin_ok:
        with min_feature(MIN_FEATURE + band):
            w.thin_wide = m.thin()
        with min_feature(MIN_FEATURE - band):
            narrow = m.thin()
        w.thin_either = bool(w.thin_wide) != bool(narrow)
    w.slack = (Fraction(snap.volume), Fraction(snap.area))
    w.tol = CAP + Fraction(w.D) + rounding(reach)
    return w


def summary(r):
    """A model answer in a few words, as a line's `intent` says it."""
    if r["outcome"] != "bodies":
        return r["outcome"]
    s = f"bodies:{len(r['bodies'])}"
    shells = max(x["shells"] for x in r["bodies"])
    return s + (f":shells:{shells}" if shells > 1 else "")


# Comparing.

def dist2(p, q):
    d = sub(p, q)
    return dot(d, d)


def near_point(p, q, tol):
    return dist2(p, q) <= tol * tol


def on_segment(p, seg, tol):
    return point_segment2(p, seg[0], seg[1]) <= tol * tol


def covered(seg, pieces, tol):
    """Whether the kernel's edges `pieces` (each on `seg`) cover all of it."""
    a, b = seg
    u = sub(b, a)
    uu = dot(u, u)
    spans = sorted(sorted(dot(sub(p, a), u) / uu for p in piece) for piece in pieces)
    gap = Fraction(tol) / Fraction(math.sqrt(float(uu)))
    at = Fraction(0)
    for lo, hi in spans:
        if lo > at + gap:
            return False
        at = max(at, hi)
    return at >= 1 - gap


def read_place(p):
    if not isinstance(p, dict) or len(p) != 1:
        raise ValueError(f"a place is one of vertex, edge, gap: {p!r}")
    (kind, v), = p.items()
    if kind == "vertex":
        return ("vertex", point(v))
    if kind == "edge":
        return ("edge", point(v[0]), point(v[1]))
    if kind == "gap":
        return ("gap", (point(v[0][0]), point(v[0][1])), (point(v[1][0]), point(v[1][1])))
    raise ValueError(f"unknown place {kind!r}")


def same_edge(e, f, tol):
    return (near_point(e[0], f[0], tol) and near_point(e[1], f[1], tol)) or (near_point(e[0], f[1], tol) and near_point(e[1], f[0], tol))


def check_nonmanifold(want_places, got, tol):
    bad = []
    edges = [w[1:3] for w in want_places if w[0] == "edge"]
    vertices = [w[1] for w in want_places if w[0] == "vertex"]
    pieces = {i: [] for i in range(len(edges))}
    for g in got:
        if g[0] == "vertex":
            if not any(near_point(g[1], v, tol) for v in vertices) and not any(on_segment(g[1], e, tol) for e in edges):
                bad.append(f"non-manifold vertex {fmt(g[1])} is no place the model names")
        elif g[0] == "edge":
            homes = [i for i, e in enumerate(edges) if on_segment(g[1], e, tol) and on_segment(g[2], e, tol)]
            if not homes:
                bad.append(f"non-manifold edge {fmt(g[1])} to {fmt(g[2])} is no place the model names")
            for i in homes:
                pieces[i].append(g[1:3])
        else:
            bad.append(f"a {g[0]} is no way to name a non-manifold place")
    for i, e in enumerate(edges):
        if not covered(e, pieces[i], tol):
            bad.append(f"the non-manifold edge {fmt(e[0])} to {fmt(e[1])} is not named")
    for v in vertices:
        if not any(g[0] == "vertex" and near_point(g[1], v, tol) for g in got):
            bad.append(f"the non-manifold vertex {fmt(v)} is not named")
    return bad


def check_thin(want_places, got, tol):
    bad = []
    for g in got:
        if g[0] == "edge":
            ok = any(w[0] == "edge" and same_edge(g[1:3], w[1:3], tol) for w in want_places)
        elif g[0] == "gap":
            ok = any(w[0] == "gap" and ((same_edge(g[1], w[1], tol) and same_edge(g[2], w[2], tol)) or (same_edge(g[1], w[2], tol) and same_edge(g[2], w[1], tol))) for w in want_places)
        else:
            ok = False
        if not ok:
            bad.append(f"thin place {g} is no place the model names")
    return bad


def fmt(p):
    return "(" + ", ".join(f"{float(x):.9g}" for x in p) + ")"


def close(got, want_, slack):
    return abs(got - want_) <= MASS_PROPS_REL * abs(want_) + slack


def check_bodies(w, got):
    bad = []
    model = w.result["bodies"]
    if len(got) != len(model):
        return [f"{len(got)} bodies where the model has {len(model)}"]
    left = list(range(len(model)))
    for k in got:
        try:
            box = point(k["box"])
            volume, area = exact(k["volume"]), exact(k["area"])
        except (KeyError, ValueError, TypeError) as e:
            return [f"a body without its numbers: {e}"]
        homes = [i for i in left if all(abs(x - y) <= w.tol for x, y in zip(box, model[i]["box"]))]
        if not homes:
            bad.append(f"no body of the model has the box {fmt(box[:3])} to {fmt(box[3:])}")
            continue
        i = min(homes, key=lambda i: abs(volume - model[i]["volume"]))
        left.remove(i)
        m = model[i]
        for key in ("faces", "edges", "vertices", "shells", "rings", "genus"):
            if key in k or key in ("faces", "edges", "vertices", "shells"):
                if k.get(key) != m[key]:
                    bad.append(f"{key} {k.get(key)} where the model has {m[key]}")
        if not close(volume, m["volume"], w.slack[0]):
            bad.append(f"volume {float(volume)!r} where the model has {float(m['volume'])!r}")
        if not close(area, m["area"], w.slack[1]):
            bad.append(f"area {float(area)!r} where the model has {float(m['area'])!r}")
    return bad


def compare(w, answer):
    """Every way `answer` disagrees with the models (none: it agrees)."""
    r = w.result
    problems = r["problems"]
    if not isinstance(answer, dict):
        return [f"no answer: {answer!r}"]
    if "error" in answer:
        e = answer["error"]
        if e == "empty":
            return [] if "empty" in problems else [f"the kernel says empty; the model: {summary(r)}"]
        allowed = set(problems) | ({"thin"} if w.thin_either and not problems else set())
        if e not in allowed or e not in ("nonmanifold", "thin"):
            return [f"the kernel says {e}; the model: {summary(r)}"]
        try:
            got = [read_place(p) for p in answer.get("where", [])]
        except (ValueError, KeyError, IndexError, TypeError) as x:
            return [f"unreadable where: {x}"]
        if not got:
            return [f"{e} without saying where"]
        if e == "nonmanifold":
            return check_nonmanifold(r["where"]["nonmanifold"], got, w.tol)
        return check_thin(w.thin_wide, got, w.tol)
    bodies = answer.get("bodies")
    if not isinstance(bodies, list):
        return [f"neither bodies nor an error: {answer!r}"]
    if not bodies:
        return [] if "empty" in problems else [f"no bodies; the model: {summary(r)}"]
    if problems and not (problems == ["thin"] and w.thin_either):
        return [f"bodies where the model says {summary(r)} ({'; '.join(map(str, r['where'].get(problems[0], [])))[:200]})"]
    return check_bodies(w, bodies)


# OpenCascade, a third opinion.

def occ_disagreements(w, op):
    """OpenCascade's own boolean of the snapped solids, moved home (A's
    place to the origin: its rounding far out is not the kernel's), its
    coplanar faces merged, against the model's bodies: counts exactly,
    volume and area to MASS_PROPS_REL (as test_box_model_occ.py). None when
    OpenCascade has no say: a non-manifold result, or a pinched face, which
    it writes its own way (test_box_model_occ.py, test_pinched_face)."""
    r = w.result
    if r["outcome"] == "nonmanifold" or r["pinched"]:
        return None
    kind, a, b, place = w.inputs
    if kind == "boxes":
        import test_box_model_occ as occ
        home = [[tuple(c - place[k % 3] for k, c in enumerate(x)) for x in s] for s in (a, b)]
    else:
        import test_convex_model_occ as occ
        home = [convex_model.Prism(p.outline, *p.z, p.rotation, sub(p.move, place)) for p in (a, b)]
    got = occ.occ_bodies(op, *home)
    keys = ("faces", "edges", "vertices", "shells", "rings")
    order = lambda d: tuple(d[k] for k in keys) + (float(d["volume"]),)  # noqa: E731
    got, model = sorted(got, key=order), sorted(r["bodies"], key=order)
    if [tuple(d[k] for k in keys) for d in got] != [tuple(d[k] for k in keys) for d in model]:
        return [f"OpenCascade's counts {[tuple(d[k] for k in keys) for d in got]} where the model has {[tuple(d[k] for k in keys) for d in model]}"]
    bad = []
    for g, m in zip(got, model):
        for k in ("volume", "area"):
            if abs(g[k] - float(m[k])) > MASS_PROPS_REL * float(m[k]):
                bad.append(f"OpenCascade's {k} {g[k]!r} where the model has {float(m[k])!r}")
    return bad


# Answers from the models, and planted wrong ones.

def text(x):
    return repr(float(x))


def place_json(p):
    if p[0] == "vertex":
        return {"vertex": [text(x) for x in p[1]]}
    if p[0] == "edge":
        return {"edge": [[text(x) for x in p[1]], [text(x) for x in p[2]]]}
    return {"gap": [[[text(x) for x in q] for q in e] for e in p[1:3]]}


def body_json(b):
    out = {k: b[k] for k in ("faces", "edges", "vertices", "rings", "shells", "genus")}
    out.update(volume=text(b["volume"]), area=text(b["area"]), box=[text(x) for x in b["box"]])
    return out


def model_answer(r):
    """The kernel's answer, written as the model gives it."""
    if r["outcome"] == "bodies":
        return {"bodies": [body_json(b) for b in r["bodies"]]}
    if r["outcome"] == "empty":
        return {"error": "empty"}
    return {"error": r["outcome"], "where": [place_json(p) for p in r["where"][r["outcome"]]]}


def plant_count_off(w, ans):
    if "bodies" in ans and ans["bodies"]:
        ans["bodies"][0]["faces"] += 1
        return ans


def plant_refusal_missed(w, ans):
    # A kernel that misses the refusal returns the bodies it would have
    # made (the model's, for a thin result), or the inputs joined, or A.
    if "error" in ans and not w.thin_either:
        bodies = w.result["bodies"] or w.fill()["bodies"] or w.alone()["bodies"]
        return {"bodies": [body_json(b) for b in bodies]}


def plant_void_lost(w, ans):
    # A kernel that loses a void returns the body without it: A, since a
    # void needs B wholly inside A, and then A ∪ B = A.
    if any(b["shells"] > 1 for b in w.result["bodies"]):
        return {"bodies": [body_json(b) for b in w.fill()["bodies"]]}


def plant_wrong_where(w, ans):
    if ans.get("error") in ("nonmanifold", "thin"):
        place = ans["where"][0]
        (kind, v), = place.items()
        first = v if kind == "vertex" else v[0] if kind == "edge" else v[0][0]
        first[0] = text(exact(first[0]) + 3 * w.tol)
        return ans


def plant_place_cut_short(w, ans):
    # The last non-manifold place: an edge named only half way, or a vertex
    # not named at all.
    if ans.get("error") == "nonmanifold":
        (kind, v), = ans["where"][-1].items()
        if kind == "edge":
            mid = [text((exact(p) + exact(q)) / 2) for p, q in zip(*v)]
            ans["where"][-1] = {"edge": [v[0], mid]}
        else:
            ans["where"].pop()
        return ans


def plant_good_refused(w, ans):
    if "bodies" in ans and ans["bodies"] and not w.thin_either:
        return {"error": "nonmanifold", "where": [{"vertex": ans["bodies"][0]["box"][:3]}]}


def plant_volume_off(w, ans):
    if "bodies" in ans and ans["bodies"]:
        b = ans["bodies"][0]
        b["volume"] = text(exact(b["volume"]) * Fraction(101, 100))
        return ans


def plant_box_off(w, ans):
    # A body a feature off: its box MIN_FEATURE out on one side.
    if "bodies" in ans and ans["bodies"]:
        b = ans["bodies"][0]
        b["box"][0] = text(exact(b["box"][0]) - MIN_FEATURE)
        return ans


PLANTS = {
    "a count off": plant_count_off,
    "a refusal missed": plant_refusal_missed,
    "a void lost": plant_void_lost,
    "a wrong where": plant_wrong_where,
    "a place cut short or missing": plant_place_cut_short,
    "a good result refused": plant_good_refused,
    "a volume 1% off": plant_volume_off,
    "a box MIN_FEATURE off": plant_box_off,
}


def run(lines, model_answers=False, planted=False, occ=False, out=None):
    """Judge `lines` (dicts); prints a summary and returns True when all is well."""
    out = out or sys.stdout
    agree, disagree, beyond, on_edge, wrong_intent = 0, [], [], [], []
    caught = {k: [0, 0] for k in PLANTS}
    occ_seen = 0
    kinds = {}
    for n, line in enumerate(lines):
        name = f"line {n + 1} ({line.get('kind')} {line.get('family')} {line.get('offset') or ''} at {line.get('place')}, {line.get('op')})".replace("  ", " ")
        kinds[line.get("kind")] = kinds.get(line.get("kind"), 0) + 1
        try:
            w = want(line)
        except OnEdge as e:
            on_edge.append(f"{name}: {e}")
            continue
        except ModelError as e:
            beyond.append(f"{name}: {e}")
            continue
        if model_answers or planted:
            answer = model_answer(w.result)
            intent = line.get("intent")
            if intent is not None and summary(w.result) not in intent.split("|"):
                wrong_intent.append(f"{name}: meant {intent}, the model says {summary(w.result)}")
        else:
            answer = line.get("answer")
        bad = compare(w, answer)
        if bad:
            disagree.append(f"{name}: " + "; ".join(bad))
        else:
            agree += 1
        if occ:
            said = occ_disagreements(w, line["op"])
            if said is not None:
                occ_seen += 1
                if said:
                    disagree.append(f"{name}: " + "; ".join(said))
        if planted:
            for kind, plant in PLANTS.items():
                wrong = plant(w, json.loads(json.dumps(model_answer(w.result))))
                if wrong is None:
                    continue
                caught[kind][1] += 1
                if compare(w, wrong):
                    caught[kind][0] += 1
                else:
                    disagree.append(f"{name}: planted {kind} not caught: {json.dumps(wrong)[:300]}")
    print(f"Judged {len(lines)} lines ({', '.join(f'{k} {v}' for k, v in sorted(kinds.items(), key=str))}): "
          f"{agree} agree, {len(disagree)} disagree, {len(beyond)} beyond the judge, {len(on_edge)} on a band's edge", file=out)
    if model_answers or planted:
        print(f"Intents: {len(wrong_intent)} wrong", file=out)
    if occ:
        print(f"OpenCascade: {occ_seen} lines compared (not non-manifold or pinched)", file=out)
    if planted:
        print("Planted: " + ", ".join(f"{k} {c}/{t}" for k, (c, t) in caught.items()), file=out)
    for msg in disagree + beyond + on_edge + wrong_intent:
        print("  " + msg, file=out)
    unused = [k for k, (_, t) in caught.items() if planted and not t]
    for k in unused:
        print(f"  planted {k} applied to no line", file=out)
    return not disagree and not beyond and not wrong_intent and not unused and not (on_edge and (model_answers or planted))


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    flags = {a for a in argv if a.startswith("--")}
    unknown = flags - {"--model-answers", "--planted", "--occ"}
    if len(args) != 1 or unknown:
        print(__doc__.split("Usage:")[1].split("Exit")[0], file=sys.stderr)
        return 2
    with open(args[0]) as f:
        lines = [json.loads(x) for x in f if x.strip()]
    if not lines:
        print("no lines to judge", file=sys.stderr)
        return 1
    ok = run(lines, "--model-answers" in flags, "--planted" in flags, "--occ" in flags)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
