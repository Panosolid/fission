"""Exact model of booleans on turned convex prisms, the second referee for
step 30's boolean fuzzing (30b; box_model.py is the first).

A prism here is a convex outline in x, y (anticlockwise, Fraction corners)
run from z0 to z1, turned about the origin by a rotation whose entries are
fractions (Pythagorean triples: cos = a/c, sin = b/c with a^2 + b^2 = c^2,
composed about any axes) and then moved. Every corner of it is then exact,
and so is every face plane: the outline's sides must have rational lengths
(their directions come from Pythagorean triples too, like 3-4-5 or 5-12-13),
so each face's outward normal is a rational unit vector, and every area,
volume and squared distance below is an exact Fraction. Outlines whose sides
have irrational lengths are refused (`ModelError`), since their areas could
not be exact.

`boolean(op, a, b)` gives what the kernel's boolean (34) must answer for two
such prisms, in box_model's dict: `outcome` (bodies, empty, nonmanifold,
thin), every applicable problem in `problems`, `where`, `pinched`, and per
body its volume, area, faces, edges, vertices, rings, shells, genus and box
after decision 6's tidying (coplanar neighbours merged, collinear edges
joined). It handles every arrangement exactly, not only general position:
coplanar faces of the same and opposite sense, faces, edges and corners
touching, a prism inside the other.

How it works: box_model's grid, generalised from axis planes to any planes.
The planes of both prisms (shared ones once) are the only places anything
can happen.
- Faces: on each plane, the lines where the other planes cross it cut it
  into convex cells. Each cell is wholly a face of the result or not, and
  which way it faces follows from whether the result is just below or just
  above its middle (each prism is "in" there when its every half-space is,
  read off exactly). Cells facing the same way that share a side are one
  face. Rings are 1 - chi of the open face, as in box_model (cells - inner
  sides + inner points), so a pinched face counts as the disc it is.
- Edges and vertices: every line where two planes meet is cut by the other
  planes into intervals. What the result looks like round the middle of an
  interval, or round a point where three or more planes meet, is decided by
  the cones the planes through it make: each cone is wholly in or out of the
  result. The place is non-manifold when the cones in the result, or those
  out of it, are not connected through shared sides (two prisms touching
  along an edge or at a corner, or a corner of the tool touching a face from
  inside); otherwise the planes where in and out change decide: one, a face
  runs through; two, a straight crease; three or more independent ones, a
  vertex. Creases between vertices are the edges. (A cone {w : s_i n_i . w > 0}
  is non-empty when Fourier-Motzkin elimination of the three coordinates
  leaves no 0 > 0, exact with strict inequalities.)
- Bodies: faces joined across edges are shells; a shell's volume (one third
  of the sum of plane offset times area, with signs) is positive outside and
  negative round a void. Two convex prisms make a void only when one lies
  strictly inside the other (subtract), and then the result is one body, so
  a void joins the only outer shell (anything else is a model bug and raises).
  The genus is read from Euler-Poincare V - E + F - R = 2(S - H).
- Every 3D boundary segment of every face lands on exactly one crease, and
  every crease has exactly two faces: checked on every manifold result
  (AssertionError otherwise), so the two halves keep each other honest.

Tolerance, as box_model: a corner of one prism within 2 x LINEAR of a face
plane of the other, or an edge of one passing within 2 x LINEAR of an edge
of the other, without touching it exactly, is the same place to the kernel
(rule 1), which this model cannot see, so it refuses them (`ModelError`;
30c snaps first). For axis-aligned boxes this is box_model's refusal of
coordinates within 2 x LINEAR.

Thin (rule 1, decision 6), as box_model: every edge at least MIN_FEATURE
long, and in each face any two boundary edges that share no vertex at least
MIN_FEATURE apart. `where` gives squared lengths and squared distances (an
edge of a turned prism can have an irrational length; its square is exact).
"""

from fractions import Fraction
from itertools import combinations, product
from math import isqrt

from box_model import LINEAR, MIN_FEATURE, OPS, SAME, ModelError, Union, q  # noqa: F401 (LINEAR for callers)

INSIDE = {
    "union": lambda a, b: a or b,
    "subtract": lambda a, b: a and not b,
    "intersect": lambda a, b: a and b,
}
ONE = Fraction(1)
IDENTITY = ((ONE, 0, 0), (0, ONE, 0), (0, 0, ONE))
AXES = {"x": 0, "y": 1, "z": 2}


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def plus(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def times(k, a):
    return (k * a[0], k * a[1], k * a[2])


def exact_sqrt(x):
    """The square root of a Fraction when it is a Fraction, else None."""
    x = Fraction(x)
    if x < 0:
        return None
    n, d = isqrt(x.numerator), isqrt(x.denominator)
    return Fraction(n, d) if n * n == x.numerator and d * d == x.denominator else None


def apply(m, p):
    return tuple(m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] for i in range(3))


def turn(axis, a, b, c):
    """A turn about `axis` ('x', 'y' or 'z') with cos a/c and sin b/c, a^2 +
    b^2 = c^2 (3, 4, 5: about 36.87 degrees). Positive turns x to y about z,
    y to z about x and z to x about y."""
    a, b, c = q(a), q(b), q(c)
    if c == 0 or a * a + b * b != c * c:
        raise ModelError(f"{a}, {b}, {c} is not a Pythagorean triple")
    k = AXES[axis]
    i, j = (k + 1) % 3, (k + 2) % 3
    m = [[Fraction(0)] * 3 for _ in range(3)]
    m[k][k] = ONE
    m[i][i], m[i][j], m[j][i], m[j][j] = a / c, -b / c, b / c, a / c
    return tuple(tuple(r) for r in m)


def compose(*turns):
    """The turns applied in the order given (the first one first)."""
    out = IDENTITY
    for t in turns:
        out = tuple(tuple(sum(t[i][k] * out[k][j] for k in range(3)) for j in range(3)) for i in range(3))
    return out


def det(m):
    return dot(m[0], cross(m[1], m[2]))


class Prism:
    """A convex prism: `outline` (x, y corners, anticlockwise) from z0 to z1,
    turned by `rotation` about the origin, then moved by `move`."""

    def __init__(self, outline, z0, z1, rotation=IDENTITY, move=(0, 0, 0)):
        pts = [(q(x), q(y)) for x, y in outline]
        z0, z1 = q(z0), q(z1)
        r = tuple(tuple(q(c) for c in row) for row in rotation)
        t = tuple(q(c) for c in move)
        n = len(pts)
        if n < 3:
            raise ModelError("an outline needs at least three corners")
        if not z0 < z1:
            raise ModelError(f"prism from z {z0} to {z1} has no volume")
        if any(dot(r[i], r[j]) != (i == j) for i in range(3) for j in range(3)) or det(r) != 1:
            raise ModelError("the rotation is not a rotation")
        sides = []
        for i in range(n):
            p, s = pts[i], pts[(i + 1) % n]
            e = (s[0] - p[0], s[1] - p[1])
            for m in pts:
                if m != p and m != s and e[0] * (m[1] - p[1]) - e[1] * (m[0] - p[0]) <= 0:
                    raise ModelError(f"outline {pts} is not strictly convex and anticlockwise")
            length = exact_sqrt(e[0] * e[0] + e[1] * e[1])
            if not length:
                raise ModelError(f"outline side {p} to {s} has no rational length")
            sides.append((e[1] / length, -e[0] / length))  # outward: to the right of an anticlockwise side
        self.outline, self.z, self.rotation, self.move = pts, (z0, z1), r, t
        self.vertices = [plus(apply(r, (x, y, z)), t) for z in (z0, z1) for x, y in pts]
        up = apply(r, (0, 0, 1))
        self.halfspaces = []  # (outward unit normal, offset): inside is normal . x <= offset
        for i, (nx, ny) in enumerate(sides):
            normal = apply(r, (nx, ny, 0))
            self.halfspaces.append((normal, dot(normal, self.vertices[i])))
        self.halfspaces.append((up, dot(up, self.vertices[n])))
        self.halfspaces.append((times(-1, up), -dot(up, self.vertices[0])))
        self.edges = [(i, (i + 1) % n) for i in range(n)] + [(n + i, n + (i + 1) % n) for i in range(n)] + [(i, n + i) for i in range(n)]

    def segments(self):
        return [(self.vertices[i], self.vertices[j]) for i, j in self.edges]


def block(x0, y0, z0, x1, y1, z1, rotation=IDENTITY, move=(0, 0, 0)):
    """A box as a prism (a rectangle run along z), optionally turned and moved."""
    x0, y0, x1, y1 = q(x0), q(y0), q(x1), q(y1)
    if not (x0 < x1 and y0 < y1):
        raise ModelError("block has no volume")
    return Prism([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1, rotation, move)


def open_cone(rows):
    """Whether some w has r . w > 0 for every row r (Fourier-Motzkin)."""
    rows = {normal_row(r) for r in rows}
    for k in range(3):
        if (0, 0, 0) in rows:
            return False
        pos = [r for r in rows if r[k] > 0]
        neg = [r for r in rows if r[k] < 0]
        rows = {r for r in rows if r[k] == 0} | {normal_row(tuple(-n[k] * p[i] + p[k] * n[i] for i in range(3))) for p in pos for n in neg}
    return (0, 0, 0) not in rows


def normal_row(r):
    """A positive multiple of r with largest entry 1 in size (same cone)."""
    m = max(abs(c) for c in r)
    return (0, 0, 0) if m == 0 else tuple(Fraction(c) / m for c in r)


def disconnected(cells, flips, want):
    """Whether the cones with value `want` fall apart (not joined through
    shared sides)."""
    group = [s for s, v in cells.items() if v == want]
    uf = Union(group)
    for s1, s2, _ in flips:
        if cells[s1] == cells[s2] == want:
            uf.join(s1, s2)
    return len({uf.find(s) for s in group}) > 1


def rank(vectors):
    vs = [v for v in vectors if any(v)]
    if not vs:
        return 0
    if any(dot(cross(a, b), c) != 0 for a, b, c in combinations(vs, 3)):
        return 3
    if any(any(cross(a, b)) for a, b in combinations(vs, 2)):
        return 2
    return 1


def segment_distance2(p0, p1, q0, q1):
    """The squared distance between two 3D segments, exactly: the least of
    the four endpoint-to-segment distances and, when the segments are not
    parallel, the distance between the closest points inside both."""
    u, v, w = sub(p1, p0), sub(q1, q0), sub(p0, q0)
    best = min(point_segment2(p0, q0, q1), point_segment2(p1, q0, q1), point_segment2(q0, p0, p1), point_segment2(q1, p0, p1))
    a, b, c, d, e = dot(u, u), dot(u, v), dot(v, v), dot(u, w), dot(v, w)
    den = a * c - b * b
    if den != 0:
        s, t = (b * e - c * d) / den, (a * e - b * d) / den
        if 0 <= s <= 1 and 0 <= t <= 1:
            g = sub(plus(p0, times(s, u)), plus(q0, times(t, v)))
            best = min(best, dot(g, g))
    return best


def point_segment2(x, a, b):
    u = sub(b, a)
    t = min(ONE, max(Fraction(0), dot(sub(x, a), u) / dot(u, u)))
    g = sub(plus(a, times(t, u)), x)
    return dot(g, g)


def others(k):
    return [a for a in range(3) if a != k]


class Measured:
    """Everything about the result of `inside` over `solids` (one or two
    prisms); see the module comment."""

    def __init__(self, solids, inside):
        self.solids = solids
        self.inside = inside
        self._planes()
        self._faces()
        self._lines()
        self._shells()

    def _planes(self):
        self.planes, self.spaces, self._sides = [], [], {}
        index = {}
        for s in self.solids:
            hs = []
            for n, d in s.halfspaces:
                sign = 1 if next(c for c in n if c != 0) > 0 else -1
                key = (times(sign, n), sign * d)
                if key not in index:
                    index[key] = len(self.planes)
                    self.planes.append(key)
                hs.append((index[key], sign))
            self.spaces.append(hs)
        pts = [v for s in self.solids for v in s.vertices]
        self.lo = tuple(min(p[a] for p in pts) for a in range(3))
        self.hi = tuple(max(p[a] for p in pts) for a in range(3))

    def side(self, j, x):
        """n . x - d for plane j (cached per point: the same corners come up
        again and again)."""
        if x not in self._sides:
            self._sides[x] = tuple(dot(n, x) - d for n, d in self.planes)
        return self._sides[x][j]

    def near(self, si, x, w):
        """Whether solid si holds x + e w for every small e > 0, given that x
        lies on no plane w runs along."""
        for j, sign in self.spaces[si]:
            v = sign * self.side(j, x)
            if v > 0 or (v == 0 and sign * dot(self.planes[j][0], w) >= 0):
                return False
        return True

    def touches(self, x):
        """Whether x is on the boundary of some solid (else nothing happens there)."""
        for hs in self.spaces:
            sides = [sign * self.side(j, x) for j, sign in hs]
            if all(v <= 0 for v in sides) and any(v == 0 for v in sides):
                return True
        return False

    # Faces: the cells of each plane.

    def _faces(self):
        self.faces = []  # dicts: plane, sense, area, cells, chi, segments (3D), pinches
        for i in range(len(self.planes)):
            self._plane_faces(i)

    def _plane_faces(self, i):
        n, d = self.planes[i]
        k = max(range(3), key=lambda c: abs(n[c]))
        a, b = others(k)

        def lift(p):
            x = [None] * 3
            x[a], x[b] = p
            x[k] = (d - n[a] * p[0] - n[b] * p[1]) / n[k]
            return tuple(x)

        def line_of(m, c):
            # m . lift(u, v) - c as (cu, cv, c0), scaled so the first of cu,
            # cv is 1 in size; None when it is constant on the plane.
            row = (m[a] - m[k] * n[a] / n[k], m[b] - m[k] * n[b] / n[k], m[k] * d / n[k] - c)
            s = abs(row[0]) if row[0] != 0 else abs(row[1])
            return tuple(x / s for x in row) if s else None

        # The plane inside the solids' box grown by 1 on every side, so no
        # face reaches its edge.
        lo, hi = [c - 1 for c in self.lo], [c + 1 for c in self.hi]
        bounds = [(1, 0, -hi[a]), (-1, 0, lo[a]), (0, 1, -hi[b]), (0, -1, lo[b])]
        poly = [((lo[a], lo[b]), 3), ((hi[a], lo[b]), 0), ((hi[a], hi[b]), 2), ((lo[a], hi[b]), 1)]
        unit_k = tuple(1 if c == k else 0 for c in range(3))
        for bound in (line_of(unit_k, hi[k]), line_of(times(-1, unit_k), -lo[k])):
            if bound is not None:  # None: the plane is square to axis k, inside the box
                bounds.append(bound)
                poly = clip(poly, bound, len(bounds) - 1)
        # Each solid on this plane as half-planes (<= 0 inside), or None
        # when a face parallel to the plane keeps the solid off it.
        shadows = []
        for hs in self.spaces:
            rows = []
            for j, sign in hs:
                m, c = self.planes[j]
                if j == i:
                    continue
                if not any(cross(m, n)):
                    if sign * self.side(j, lift((0, 0))) > 0:
                        rows = None
                        break
                    continue
                rows.append(line_of(times(sign, m), sign * c))
            shadows.append(rows)

        def live(cell, solids):
            # The solids the cell may be in: those it is not wholly beyond
            # one half-plane of. Only their lines can change what the cell
            # is, so only those split it (a cell off every solid is never
            # a face and is never split again).
            return frozenset(s for s in solids if shadows[s] is not None
                             and not any(all(value(r, p) >= 0 for p, _ in cell) for r in shadows[s]))

        owners = [{s for s, hs in enumerate(self.spaces) if any(j == jj for jj, _ in hs)} for j in range(len(self.planes))]
        # Planes meeting this one along the same line (three planes through
        # one line) split it once, for every solid owning any of them.
        cuts = {}
        for j, (m, c) in enumerate(self.planes):
            if j == i or not any(cross(m, n)):
                continue
            line = line_of(m, c)
            if line[0] < 0 or (line[0] == 0 and line[1] < 0):
                line = tuple(-x for x in line)
            if line not in bounds:
                cuts.setdefault(line, set()).update(owners[j])
        lines = list(bounds)
        cells = [(poly, live(poly, range(len(self.solids))))]
        for line, owned in cuts.items():
            lines.append(line)
            lid = len(lines) - 1
            split = []
            for cell, solids in cells:
                vals = [value(line, p) for p, _ in cell] if solids & owned else [0]
                if all(v <= 0 for v in vals) or all(v >= 0 for v in vals):
                    split.append((cell, solids))
                else:
                    for half in (line, tuple(-x for x in line)):
                        piece = clip(cell, half, lid)
                        if area2(piece) > 0:
                            split.append((piece, live(piece, solids)))
            cells = split
        # Every cell gets every arrangement point on its sides, so cells
        # that share a side share it exactly (a point on a line is the end
        # of the side along it of a cell that line's crossing split).
        on_line = {}
        for cell, _ in cells:
            for idx, (p, lid) in enumerate(cell):
                on_line.setdefault(lid, set()).update((p, cell[(idx + 1) % len(cell)][0]))
        polys = []
        for cell, _ in cells:
            pts = []
            for idx, (p, lid) in enumerate(cell):
                r = cell[(idx + 1) % len(cell)][0]
                e = (r[0] - p[0], r[1] - p[1])
                ee = e[0] * e[0] + e[1] * e[1]
                along = [((m[0] - p[0]) * e[0] + (m[1] - p[1]) * e[1], m) for m in on_line[lid] if m != p and m != r]
                pts.append(p)
                pts.extend(m for t, m in sorted(along) if 0 < t < ee)
            polys.append(pts)
        # Which way each cell faces: +1 when the result is just below (on
        # the -n side) and not just above, -1 the other way, 0 not a face.
        sense = []
        for (_, solids), pts in zip(cells, polys):
            if not solids:
                sense.append(0)
                continue
            x = lift(centre(pts))
            below = self.inside(*(self.near(s, x, times(-1, n)) for s in range(len(self.solids))))
            above = self.inside(*(self.near(s, x, n) for s in range(len(self.solids))))
            sense.append(0 if below == above else (1 if below else -1))
        sides = {}
        for ci, pts in enumerate(polys):
            for idx, p in enumerate(pts):
                r = pts[(idx + 1) % len(pts)]
                sides.setdefault((min(p, r), max(p, r)), []).append(ci)
        uf = Union(range(len(polys)))
        for cs in sides.values():
            if len(cs) == 2 and sense[cs[0]] == sense[cs[1]] != 0:
                uf.join(cs[0], cs[1])
        face_ids = {}
        for ci in range(len(polys)):
            if sense[ci]:
                face_ids.setdefault(uf.find(ci), len(self.faces) + len(face_ids))
        if not face_ids:
            return
        mine = {root: dict(plane=i, sense=None, area=Fraction(0), cells=[], chi=0, segments=[], pinches=[]) for root in face_ids}
        face_of = {}
        for ci in range(len(polys)):
            if sense[ci]:
                f = mine[uf.find(ci)]
                f["sense"] = sense[ci]
                f["area"] += area2(polys[ci]) / 2 / abs(n[k])
                f["cells"].append(ci)
                f["chi"] += 1
                face_of[ci] = uf.find(ci)
        for (p, r), cs in sides.items():
            fs = [face_of.get(c) for c in cs]
            if len(cs) == 2 and fs[0] is not None and fs[0] == fs[1]:
                mine[fs[0]]["chi"] -= 1
            else:
                for f in set(fs) - {None}:
                    mine[f]["segments"].append((lift(p), lift(r)))
        joined = {}
        for (p, r), cs in sides.items():
            if len(cs) == 2 and face_of.get(cs[0]) is not None and face_of.get(cs[0]) == face_of.get(cs[1]):
                for x in (p, r):
                    joined[(x, face_of[cs[0]])] = joined.get((x, face_of[cs[0]]), 0) + 1
        around = {}
        for ci, pts in enumerate(polys):
            for p in pts:
                around.setdefault(p, []).append(ci)
        for p, cs in around.items():
            fs = [face_of.get(c) for c in cs]
            if fs[0] is not None and all(f == fs[0] for f in fs):
                mine[fs[0]]["chi"] += 1
                continue
            # A pinch: one face in two or more separate runs round p. The
            # cells round p make a ring, neighbours sharing a side from p,
            # so a face's runs are its cells less its sides from p.
            for f in set(fs) - {None}:
                if fs.count(f) - joined.get((p, f), 0) >= 2:
                    mine[f]["pinches"].append(lift(p))
        for root in sorted(mine, key=lambda r: face_ids[r]):
            self.faces.append(mine[root])

    # Edges and vertices: the lines where planes meet.

    def _lines(self):
        # Only lines carrying a side of some face can hold an edge or a
        # non-manifold place (both have faces ending there), and on them
        # only the intervals and points those sides cover.
        self.kinds = {}  # point -> kind, cached
        lines, covered = {}, {}
        for f in self.faces:
            for p, r in f["segments"]:
                key = frozenset(m for m in range(len(self.planes)) if self.side(m, p) == 0 and self.side(m, r) == 0)
                if key not in lines:
                    i, j = next((i, j) for i, j in combinations(sorted(key), 2) if any(cross(self.planes[i][0], self.planes[j][0])))
                    (ni, di), (nj, dj) = self.planes[i], self.planes[j]
                    u = cross(ni, nj)
                    lines[key] = (solve((ni, nj, u), (di, dj, 0)), u)
                covered.setdefault(key, []).append((p, r))
        self.lines = {}
        self.edges = []  # dicts: ends (2 points), length2, faces
        self.edge_at = {}  # (line key, interval) -> edge index
        bad_runs = []
        for key, (x0, u) in lines.items():
            ts = sorted({(self.planes[m][1] - dot(self.planes[m][0], x0)) / dot(self.planes[m][0], u)
                         for m in range(len(self.planes)) if m not in key and dot(self.planes[m][0], u) != 0})
            self.lines[key] = (x0, u, ts)
            at = lambda t: plus(x0, times(t, u))  # noqa: E731
            used = set()
            for p, r in covered[key]:
                t0, t1 = sorted((self._t(key, p), self._t(key, r)))
                for idx, t in enumerate(ts):
                    if t0 <= t <= t1:
                        self.kind(at(t))
                        if t < t1:
                            used.add(idx)
            kinds = [self.kind(at((t0 + t1) / 2)) if idx in used else "none" for idx, (t0, t1) in enumerate(zip(ts, ts[1:]))]
            run, bad = None, None
            for idx, kd in enumerate(kinds):
                start = at(ts[idx])
                if kd == "crease":
                    if run is None or self.kind(start) == "vertex" or kinds[idx - 1] != "crease":
                        run = len(self.edges)
                        self.edges.append(dict(ends=[start, None], line=key, length2=Fraction(0), faces=set()))
                    self.edge_at[(key, idx)] = run
                    self.edges[run]["ends"][1] = at(ts[idx + 1])
                    self.edges[run]["length2"] = (ts[idx + 1] - self._t(key, self.edges[run]["ends"][0])) ** 2 * dot(u, u)
                else:
                    run = None
                if kd == "nonmanifold":
                    if bad is None:
                        bad = [start, None]
                        bad_runs.append(bad)
                    bad[1] = at(ts[idx + 1])
                else:
                    bad = None
        self.vertices = sorted(p for p, kd in self.kinds.items() if kd == "vertex")
        on_bad = set()
        for p0, p1 in bad_runs:
            for p, kd in self.kinds.items():
                if on_segment(p, p0, p1):
                    on_bad.add(p)
        self.nonmanifold = sorted([("edge",) + tuple(sorted((p0, p1))) for p0, p1 in bad_runs]
                                  + [("vertex", p) for p, kd in self.kinds.items() if kd == "nonmanifold" and p not in on_bad])

    def _t(self, key, p):
        x0, u, _ = self.lines[key]
        return dot(sub(p, x0), u) / dot(u, u)

    def kind(self, x):
        """'none', 'flat', 'crease', 'vertex' or 'nonmanifold' round x."""
        if x in self.kinds:
            return self.kinds[x]
        out = "none"
        if self.touches(x):
            out = self._cones(x)
        self.kinds[x] = out
        return out

    def _cones(self, x):
        through = [j for j in range(len(self.planes)) if self.side(j, x) == 0]
        normals = [self.planes[j][0] for j in through]
        near, active = [], []
        for hs in self.spaces:
            sides = [(through.index(j) if self.side(j, x) == 0 else None, sign, sign * self.side(j, x)) for j, sign in hs]
            near.append(all(v <= 0 for _, _, v in sides))
            active.append([(m, sign) for m, sign, v in sides if m is not None])
        cells = {}
        free = rank(normals) == len(normals)  # independent normals: every sign pattern is a cone
        for sig in product((1, -1), repeat=len(through)):
            if not free and not open_cone([times(s, nm) for s, nm in zip(sig, normals)]):
                continue
            ins = [near[si] and all(sign * sig[m] < 0 for m, sign in active[si]) for si in range(len(self.spaces))]
            cells[sig] = bool(self.inside(*ins))
        if len(set(cells.values())) < 2:
            return "none"
        flips = [(s1, s2, m) for s1 in cells for m in range(len(through))
                 for s2 in [s1[:m] + (-s1[m],) + s1[m + 1:]] if s2 in cells and s1 < s2]
        if disconnected(cells, flips, True) or disconnected(cells, flips, False):
            return "nonmanifold"
        relevant = {m for s1, s2, m in flips if cells[s1] != cells[s2]}
        return {1: "flat", 2: "crease", 3: "vertex"}[rank([normals[m] for m in relevant])]

    # Faces joined across edges: shells and bodies.

    def _shells(self):
        self.manifold = not self.nonmanifold
        self.problems_found = []
        if not self.manifold:
            return
        for fi, f in enumerate(self.faces):
            f["edges"] = set()
            for p, r in f["segments"]:
                key = frozenset(m for m in range(len(self.planes)) if self.side(m, p) == 0 and self.side(m, r) == 0)
                ts = self.lines[key][2]
                t0, t1 = sorted((self._t(key, p), self._t(key, r)))
                for idx, t in enumerate(ts):
                    if t0 <= t < t1:
                        e = self.edge_at.get((key, idx))
                        if e is None:
                            raise AssertionError(f"a face's side at {p}..{r} lies on no crease")
                        f["edges"].add(e)
                        self.edges[e]["faces"].add(fi)
        uf = Union(range(len(self.faces)))
        for e, edge in enumerate(self.edges):
            if len(edge["faces"]) != 2:
                raise AssertionError(f"crease {edge['ends']} has {len(edge['faces'])} faces")
            f1, f2 = edge["faces"]
            uf.join(f1, f2)
        self.shell_of = {fi: uf.find(fi) for fi in range(len(self.faces))}
        ends = {}
        for e, edge in enumerate(self.edges):
            for p in edge["ends"]:
                ends.setdefault(p, e)
        self.vertex_shell = {}
        for p in self.vertices:
            if p not in ends:
                raise AssertionError(f"vertex {p} ends no edge")
            self.vertex_shell[p] = self.shell_of[next(iter(self.edges[ends[p]]["faces"]))]

    # The answers.

    def body_list(self):
        shells = {}
        for fi, s in self.shell_of.items():
            d = shells.setdefault(s, dict(faces=[], volume=Fraction(0)))
            d["faces"].append(fi)
            f = self.faces[fi]
            d["volume"] += f["sense"] * self.planes[f["plane"]][1] * f["area"] / 3
        body_of = self._owners(shells)
        bodies = {}
        for s, d in shells.items():
            b = bodies.setdefault(body_of[s], dict(faces=[], shells=0, volume=Fraction(0)))
            b["faces"] += d["faces"]
            b["shells"] += 1
            b["volume"] += d["volume"]
        out = []
        for b, d in bodies.items():
            faces = [self.faces[fi] for fi in d["faces"]]
            edges = [e for e, edge in enumerate(self.edges) if body_of[self.shell_of[next(iter(edge["faces"]))]] == b]
            vertices = [p for p in self.vertices if body_of[self.vertex_shell[p]] == b]
            rings = sum(1 - f["chi"] for f in faces)
            chi = len(vertices) - len(edges) + len(faces) - rings
            if (2 * d["shells"] - chi) % 2:
                raise AssertionError(f"Euler-Poincare gives a half genus: chi {chi}")
            out.append({
                "volume": d["volume"],
                "area": sum(f["area"] for f in faces),
                "faces": len(faces),
                "edges": len(edges),
                "vertices": len(vertices),
                "rings": rings,
                "shells": d["shells"],
                "genus": (2 * d["shells"] - chi) // 2,
                "box": tuple(min(p[a] for p in vertices) for a in range(3)) + tuple(max(p[a] for p in vertices) for a in range(3)),
            })
        out.sort(key=lambda d: (d["box"], d["volume"]))
        return out

    @staticmethod
    def _owners(shells):
        """The body each shell belongs to: outer shells (positive volume)
        their own, a void the one outer shell (see the module comment)."""
        outer = [s for s, d in shells.items() if d["volume"] > 0]
        voids = [s for s, d in shells.items() if d["volume"] < 0]
        if voids and len(outer) != 1:
            raise AssertionError(f"{len(voids)} voids among {len(outer)} outer shells")
        return {s: (s if s in outer else outer[0]) for s in shells}

    def pinched(self):
        return sorted(p for f in self.faces for p in f["pinches"])

    def thin(self):
        out = []
        for edge in self.edges:
            if edge["length2"] < MIN_FEATURE * MIN_FEATURE:
                out.append(("edge",) + tuple(sorted(edge["ends"])) + (edge["length2"],))
        for f in self.faces:
            es = sorted(f["edges"])
            for i, e1 in enumerate(es):
                for e2 in es[i + 1:]:
                    a, b = self.edges[e1]["ends"], self.edges[e2]["ends"]
                    if set(a) & set(b):
                        continue
                    d2 = segment_distance2(a[0], a[1], b[0], b[1])
                    if d2 < MIN_FEATURE * MIN_FEATURE:
                        out.append(("gap", tuple(sorted(a)), tuple(sorted(b)), d2))
        return sorted(set(out), key=repr)


def value(line, p):
    return line[0] * p[0] + line[1] * p[1] + line[2]


def clip(poly, line, lid):
    """The part of a convex cell where `line` is <= 0. A cell is a list of
    (corner, id of the line its side from that corner runs along)."""
    out = []
    for idx, (p, pid) in enumerate(poly):
        r = poly[(idx + 1) % len(poly)][0]
        vp, vr = value(line, p), value(line, r)
        if vp <= 0:
            out.append((p, pid if vr <= 0 or vp < 0 else lid))
        if (vp < 0 < vr) or (vr < 0 < vp):
            s = vp / (vp - vr)
            x = (p[0] + s * (r[0] - p[0]), p[1] + s * (r[1] - p[1]))
            out.append((x, lid if vp < 0 else pid))
    return out


def area2(cell):
    """Twice the area of an anticlockwise cell (corners, or (corner, line id))."""
    pts = [c[0] if isinstance(c[0], tuple) else c for c in cell]
    return sum(pts[i - 1][0] * pts[i][1] - pts[i][0] * pts[i - 1][1] for i in range(len(pts)))


def centre(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def solve(rows, rhs):
    """x with rows[i] . x = rhs[i] (Cramer's rule; rows independent)."""
    dt = det(rows)
    out = []
    for c in range(3):
        m = [list(r) for r in rows]
        for i in range(3):
            m[i][c] = rhs[i]
        out.append(Fraction(det(m)) / dt)
    return tuple(out)


def on_segment(p, a, b):
    return not any(cross(sub(p, a), sub(b, a))) and 0 <= dot(sub(p, a), sub(b, a)) <= dot(sub(b, a), sub(b, a))


def refuse_close(a, b):
    """Rule 1's refusal: a corner of one prism within 2 x LINEAR of a face
    plane of the other, or edges passing within 2 x LINEAR, without touching."""
    for s, t in ((a, b), (b, a)):
        for v in s.vertices:
            for n, d in t.halfspaces:
                gap = abs(dot(n, v) - d)
                if 0 < gap <= SAME:
                    raise ModelError(f"corner {v} is within tolerance of the plane {n} . x = {d}")
    for p0, p1 in a.segments():
        for q0, q1 in b.segments():
            if any(min(q0[k], q1[k]) - max(p0[k], p1[k]) > SAME or min(p0[k], p1[k]) - max(q0[k], q1[k]) > SAME for k in range(3)):
                continue  # their boxes are further apart than that
            d2 = segment_distance2(p0, p1, q0, q1)
            if 0 < d2 <= SAME * SAME:
                raise ModelError(f"edges {p0}..{p1} and {q0}..{q1} pass within tolerance")


def judge(m, empty):
    problems, where = [], {}
    if empty:
        problems.append("empty")
    if m.nonmanifold:
        problems.append("nonmanifold")
        where["nonmanifold"] = m.nonmanifold
    thin = m.thin() if not empty and not m.nonmanifold else []
    if thin:
        problems.append("thin")
        where["thin"] = thin
    return {
        "outcome": problems[0] if problems else "bodies",
        "problems": problems,
        "where": where,
        "pinched": m.pinched(),
        "bodies": m.body_list() if not empty and not m.nonmanifold else [],
    }


def solid(p):
    """A lone prism measured as the kernel would see it: the same dict."""
    if not hasattr(p, "_alone"):
        m = Measured([p], lambda a: a)
        p._alone = judge(m, not m.faces)
    return p._alone


def check_input(name, p):
    r = solid(p)
    if r["problems"]:
        raise ModelError(f"input {name} is {r['outcome']} at {r['where']}")
    return r


def boolean(op, a, b):
    """The kernel's answer for `a op b`, two Prisms (see `solid` and
    box_model.boolean for the dict)."""
    if op not in OPS:
        raise ModelError(f"unknown operation {op!r}")
    if not isinstance(a, Prism) or not isinstance(b, Prism):
        raise ModelError("each input must be a Prism")
    refuse_close(a, b)
    check_input("A", a)
    check_input("B", b)
    m = Measured([a, b], INSIDE[op])
    return judge(m, not m.faces)
