"""Exact model of booleans on boxes, the referee for step 30's boolean fuzzing.

A solid here is a union of axis-aligned boxes with exact (Fraction)
coordinates, so union, subtract and intersect of two of them is again such a
solid, and every number the kernel's boolean (34) must give for it can be
worked out exactly, with no rounding anywhere: the volume, the area, the
bodies (one per connected piece, B0 decision 3), each body's faces, edges,
vertices, shells (voids) and genus after tidying (decision 6: coplanar
neighbours merged, collinear edges joined), its box, and whether the result
must be refused instead: empty (F3, F3b), non-manifold (decision 2, with
where) or thin (rule 1 and decision 6, with where). 32a, 33b and 34c test
against it; 30c's generator and judge feed it the kernel's inputs.

How it works. The coordinates of every box are sorted per axis into a grid;
each cell of the grid is wholly in or out of each box, so a solid is a set of
cells and a boolean is a set operation on cells. Everything else is read off
the cells round each place:
- A boundary square is a cell face with the result on one side only. Squares
  in the same plane facing the same way that share a side are one face (two
  squares sharing a side are always flat there).
- A grid segment is an edge piece when the four cells round it hold one or
  three result cells (a crease), and non-manifold when they hold two
  diagonally opposite ones (the edge is used four times).
- A grid point is a vertex when the eight cells round it are not the same
  along any axis (if they are the same along an axis, the surface there is a
  plane or a straight crease running through). It is non-manifold when the
  result cells, or the other cells, among the eight are not connected through
  shared cell faces (two cubes touching at a corner; their inverse).
  test_box_model.py checks this rule against the textbook one (the faces
  round the point form one disc) on all 256 arrangements.
- Edges are runs of crease pieces along a line, broken at vertices.
- Bodies are the result cells connected through shared cell faces; shells are
  the connected regions of the other cells (the outside, and each void) that a
  body touches.
- Euler-Poincare: V - E + F - R = 2(S - H) per body, with R the rings. A face
  can touch itself at a vertex (a pinch, `pinched`), where "rings = inner
  loops" stops being well defined, so a face's rings are 1 - chi, chi being
  the Euler characteristic of the open face (open squares minus the sides
  inside it plus the grid points inside it, the compactly supported one,
  which adds up over open pieces): 0 for a disc, 1 for an annulus, and 0 for
  a pinched disc, which is a disc. That makes the formula exact, so the genus
  H is read from it.

Tolerance. Coordinates within 2 x LINEAR of each other (the sum of two
default tolerances) are the same place to the kernel (rule 1), which this
model cannot see, so it refuses them (`ModelError`); the generator (30c)
snaps such inputs first and judges the kernel against the snapped model.
Coordinates further apart are taken as given, so a 50 nm step between them
shows up in the result and is judged by the thin rule, as the kernel must.

Thin (rule 1, decision 6): every edge at least MIN_FEATURE long, and in each
face any two boundary edges that share no vertex at least MIN_FEATURE apart
(the profile rule per face). Distances between two axis-aligned segments are
exact: the gaps between their extents along each axis, squared and summed.

Several problems: `problems` lists every one that applies, `outcome` names
the first in the order empty, nonmanifold, thin; the kernel may report any
one in `problems` (30c's judge accepts each).
"""

from fractions import Fraction

LINEAR = Fraction(1, 100_000)  # kernel/src/tolerance.rs, 10 nm in mm
MIN_FEATURE = Fraction(1, 1_000)  # 1 um
SAME = 2 * LINEAR  # rule 1: within the sum of two default tolerances
OPS = ("union", "subtract", "intersect")
OUTSIDE = (-1, -1, -1)  # the region off the grid, as one more "cell" (no cell has a negative index)


class ModelError(ValueError):
    """Input the model cannot judge: a bad box, coordinates within tolerance,
    or an input that is not one valid body."""


def q(x):
    """An exact number: ints, Fractions, decimal strings, and floats as the
    exact value of the double."""
    if isinstance(x, float):
        return Fraction(x)
    return Fraction(x)


def box(x0, y0, z0, x1, y1, z1):
    lo = (q(x0), q(y0), q(z0))
    hi = (q(x1), q(y1), q(z1))
    if not all(a < b for a, b in zip(lo, hi)):
        raise ModelError(f"box {lo} to {hi} has no volume")
    return lo + hi


class Grid:
    """The sorted coordinates of every box, per axis."""

    def __init__(self, solids):
        self.coords = []
        for axis in range(3):
            cs = sorted({b[axis] for s in solids for b in s} | {b[axis + 3] for s in solids for b in s})
            for a, b in zip(cs, cs[1:]):
                if b - a <= SAME:
                    raise ModelError(f"coordinates {a} and {b} on axis {'xyz'[axis]} are within tolerance")
            self.coords.append(cs)
        self.size = tuple(len(c) - 1 for c in self.coords)

    def cells(self, boxes):
        out = set()
        for b in boxes:
            ranges = [range(self.coords[a].index(b[a]), self.coords[a].index(b[a + 3])) for a in range(3)]
            out.update((i, j, k) for i in ranges[0] for j in ranges[1] for k in ranges[2])
        return frozenset(out)

    def width(self, axis, i):
        return self.coords[axis][i + 1] - self.coords[axis][i]


class Union:
    def __init__(self, items):
        self.parent = {x: x for x in items}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def join(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def unit(axis, step=1):
    return tuple(step if a == axis else 0 for a in range(3))


def add(p, d):
    return (p[0] + d[0], p[1] + d[1], p[2] + d[2])


def others(axis):
    return [a for a in range(3) if a != axis]


def octant(cells, point):
    """The eight cells round a grid point, keyed by offset (0 or 1 per axis:
    1 is the cell on the high side)."""
    return {o: add(point, (o[0] - 1, o[1] - 1, o[2] - 1)) in cells for o in OFFSETS}


OFFSETS = [(a, b, c) for a in (0, 1) for b in (0, 1) for c in (0, 1)]


def connected(offsets):
    """Whether a set of the eight octant offsets is connected through shared
    cell faces (offsets differing in one place)."""
    offsets = list(offsets)
    if not offsets:
        return True
    seen = {offsets[0]}
    todo = [offsets[0]]
    while todo:
        o = todo.pop()
        for n in offsets:
            if n not in seen and sum(x != y for x, y in zip(o, n)) == 1:
                seen.add(n)
                todo.append(n)
    return len(seen) == len(offsets)


def point_kind(config):
    """'none' (not on the boundary), 'flat' (a plane or straight crease runs
    through), 'vertex', or 'nonmanifold', for an octant configuration."""
    ins = [o for o in OFFSETS if config[o]]
    if len(ins) in (0, 8):
        return "none"
    if not connected(ins) or not connected([o for o in OFFSETS if not config[o]]):
        return "nonmanifold"
    for axis in range(3):
        if all(config[o] == config[tuple(1 if a == axis else o[a] for a in range(3))] for o in OFFSETS if o[axis] == 0):
            return "flat"
    return "vertex"


def segment_kind(cells, axis, point):
    """The grid segment from grid point `point` one cell along `axis`: the
    four cells round it decide 'none', 'flat', 'crease' or 'nonmanifold'."""
    u, v = others(axis)
    round_it = []
    for du, dv in ((-1, -1), (0, -1), (0, 0), (-1, 0)):  # in order round the segment
        c = list(point)
        c[u] += du
        c[v] += dv
        round_it.append(tuple(c) in cells)
    n = sum(round_it)
    if n in (1, 3):
        return "crease"
    if n == 2 and round_it[0] == round_it[2]:
        return "nonmanifold"
    return "none" if n in (0, 4) else "flat"


class Measured:
    """Everything about one set of cells; see the module comment."""

    def __init__(self, grid, cells):
        self.grid = grid
        self.cells = cells
        self._squares()
        self._points_and_segments()
        self._bodies()

    def point(self, p):
        return tuple(self.grid.coords[a][p[a]] for a in range(3))

    def _squares(self):
        # A square: (axis, grid point at its low corner, sign), sign +1 when
        # the result is on the low side (its outward normal is +axis).
        self.squares = {}
        for c in self.cells:
            for axis in range(3):
                for s in (-1, 1):
                    if add(c, unit(axis, s)) not in self.cells:
                        corner = add(c, unit(axis, 1)) if s > 0 else c
                        self.squares[(axis, corner, s)] = c
        uf = Union(self.squares)
        for (axis, corner, s) in self.squares:
            for b in others(axis):
                n = (axis, add(corner, unit(b)), s)
                if n in self.squares:
                    uf.join((axis, corner, s), n)
        self.face_of = {sq: uf.find(sq) for sq in self.squares}

    def _points_and_segments(self):
        g = self.grid
        pts = {add(c, o) for c in self.cells for o in OFFSETS}
        self.kind = {p: point_kind(octant(self.cells, p)) for p in pts}
        self.vertices = {p for p, k in self.kind.items() if k == "vertex"}
        self.bad_points = sorted(p for p, k in self.kind.items() if k == "nonmanifold")
        creases, bad_segments = [], []
        for p in pts:
            for axis in range(3):
                q_ = add(p, unit(axis))
                if q_ not in pts:
                    continue
                k = segment_kind(self.cells, axis, p)
                if k == "crease":
                    creases.append((axis, p))
                elif k == "nonmanifold":
                    bad_segments.append((axis, p))
        # Edges: crease pieces along one line, joined where the point between
        # them is not a vertex (it is then the same along that line, so the
        # next piece is a crease too: see the module comment).
        uf = Union(creases)
        cs = set(creases)
        for axis, p in creases:
            n = add(p, unit(axis))
            if (axis, n) in cs and self.kind[n] != "vertex":
                uf.join((axis, p), (axis, n))
        self.edge_of = {c: uf.find(c) for c in creases}
        self.edges = {}
        for (axis, p), e in self.edge_of.items():
            lo, hi, length = self.edges.get(e, (p, add(p, unit(axis)), 0))
            self.edges[e] = (min(lo, p), max(hi, add(p, unit(axis))), length + g.width(axis, p[axis]))
        # Non-manifold places, for the overlay: segment runs and lone points.
        uf = Union(bad_segments)
        bs = set(bad_segments)
        for axis, p in bad_segments:
            n = add(p, unit(axis))
            if (axis, n) in bs:
                uf.join((axis, p), (axis, n))
        runs = {}
        for axis, p in bad_segments:
            r = uf.find((axis, p))
            lo, hi = runs.get(r, (p, add(p, unit(axis))))
            runs[r] = (min(lo, p), max(hi, add(p, unit(axis))))
        on_bad = {p for lo, hi in runs.values() for p in pts if self._between(p, lo, hi)}
        self.nonmanifold = sorted(
            [("edge", self.point(lo), self.point(hi)) for lo, hi in runs.values()]
            + [("vertex", self.point(p)) for p in self.bad_points if p not in on_bad]
        )

    @staticmethod
    def _between(p, lo, hi):
        return all(lo[a] <= p[a] <= hi[a] for a in range(3))

    def _bodies(self):
        uf = Union(self.cells)
        for c in self.cells:
            for axis in range(3):
                n = add(c, unit(axis))
                if n in self.cells:
                    uf.join(c, n)
        self.body_of = {c: uf.find(c) for c in self.cells}
        # The other cells: every cell of the grid not in the result, plus the
        # outside (any step off the grid).
        size = self.grid.size
        rest = {(i, j, k) for i in range(size[0]) for j in range(size[1]) for k in range(size[2])} - self.cells
        out = Union(rest | {OUTSIDE})
        for c in rest:
            for axis in range(3):
                for s in (-1, 1):
                    n = add(c, unit(axis, s))
                    if not all(0 <= n[a] < size[a] for a in range(3)):
                        out.join(c, OUTSIDE)
                    elif n in rest:
                        out.join(c, n)
        self.region_of = {}
        for c in self.cells:
            for axis in range(3):
                for s in (-1, 1):
                    n = add(c, unit(axis, s))
                    inside_grid = all(0 <= n[a] < size[a] for a in range(3))
                    if n not in self.cells:
                        self.region_of.setdefault(self.body_of[c], set()).add(out.find(n) if inside_grid else out.find(OUTSIDE))

    # The answers.

    def manifold(self):
        return not self.nonmanifold

    def body_list(self):
        """One dict per body, sorted by box then volume; only meaningful
        for a manifold result."""
        g = self.grid
        bodies = {}
        for c, b in self.body_of.items():
            d = bodies.setdefault(b, {"cells": [], "faces": set(), "edges": set(), "vertices": set()})
            d["cells"].append(c)
        for sq, c in self.squares.items():
            bodies[self.body_of[c]]["faces"].add(self.face_of[sq])
        for (axis, p), e in self.edge_of.items():
            bodies[self._body_at_segment(axis, p)]["edges"].add(e)
        for p in self.vertices:
            bodies[self._body_at_point(p)]["vertices"].add(p)
        rings = self._rings()
        out = []
        for b, d in bodies.items():
            cells = d["cells"]
            volume = sum(g.width(0, c[0]) * g.width(1, c[1]) * g.width(2, c[2]) for c in cells)
            area = sum(self._square_area(sq) for sq, c in self.squares.items() if self.body_of[c] == b)
            r = sum(rings[f] for f in d["faces"])
            shells = len(self.region_of[b])
            chi = len(d["vertices"]) - len(d["edges"]) + len(d["faces"]) - r
            if (2 * shells - chi) % 2:
                raise AssertionError(f"Euler-Poincare gives a half genus for body {b}: chi {chi}")
            lo = tuple(min(g.coords[a][c[a]] for c in cells) for a in range(3))
            hi = tuple(max(g.coords[a][c[a] + 1] for c in cells) for a in range(3))
            out.append({
                "volume": volume,
                "area": area,
                "faces": len(d["faces"]),
                "edges": len(d["edges"]),
                "vertices": len(d["vertices"]),
                "rings": r,
                "shells": shells,
                "genus": (2 * shells - chi) // 2,
                "box": lo + hi,
            })
        out.sort(key=lambda d: (d["box"], d["volume"]))
        return out

    def _square_area(self, sq):
        axis, corner, _ = sq
        u, v = others(axis)
        return self.grid.width(u, corner[u]) * self.grid.width(v, corner[v])

    def _body_at_segment(self, axis, p):
        u, v = others(axis)
        for du in (-1, 0):
            for dv in (-1, 0):
                c = list(p)
                c[u] += du
                c[v] += dv
                if tuple(c) in self.cells:
                    return self.body_of[tuple(c)]
        raise AssertionError("a crease with no cell")

    def _body_at_point(self, p):
        for o in OFFSETS:
            c = add(p, (o[0] - 1, o[1] - 1, o[2] - 1))
            if c in self.cells:
                return self.body_of[c]
        raise AssertionError("a vertex with no cell")

    def _rings(self):
        """1 - chi(open face) per face: open squares - inner sides + inner
        points (see the module comment)."""
        chi = {}
        for sq, f in self.face_of.items():
            chi[f] = chi.get(f, 0) + 1
            axis, corner, s = sq
            for b in others(axis):
                n = (axis, add(corner, unit(b)), s)
                if self.face_of.get(n) == f:
                    chi[f] -= 1
            # The grid point at the square's high corner (both in-plane
            # directions +1) is inside the face when all four squares round
            # it are; counting each point once through this square.
            u, v = others(axis)
            hi = add(add(corner, unit(u)), unit(v))
            round_it = [(axis, tuple(hi[a] - (du if a == u else 0) - (dv if a == v else 0) for a in range(3)), s) for du, dv in ((0, 0), (1, 0), (0, 1), (1, 1))]
            if all(self.face_of.get(r) == f for r in round_it):
                chi[f] += 1
        return {f: 1 - c for f, c in chi.items()}

    def pinched(self):
        """Points where a face touches itself: two of the four squares round
        the point in that plane belong to the face, diagonally opposite."""
        out = []
        seen = set()
        for (axis, corner, s), f in self.face_of.items():
            u, v = others(axis)
            for eu, ev in ((0, 0), (1, 0), (0, 1), (1, 1)):
                p = add(add(corner, unit(u, eu)), unit(v, ev))
                if (axis, p, s) in seen:
                    continue
                seen.add((axis, p, s))
                # The four squares round p in this plane, in order round it.
                ring = [self.face_of.get((axis, tuple(p[a] - (du if a == u else 0) - (dv if a == v else 0) for a in range(3)), s)) for du, dv in ((1, 1), (0, 1), (0, 0), (1, 0))]
                for i in (0, 1):
                    f = ring[i]
                    if f is not None and ring[i + 2] == f and ring[i + 1] != f and ring[(i + 3) % 4] != f:
                        out.append(self.point(p))
        return sorted(out)

    def thin(self):
        """Every place the thin rule refuses: ('edge', from, to, length) for a
        short edge, ('gap', edge, edge, distance squared) for two edges of one
        face that share no vertex and lie closer than MIN_FEATURE."""
        out = []
        for e, (lo, hi, length) in self.edges.items():
            if length < MIN_FEATURE:
                out.append(("edge", self.point(lo), self.point(hi), length))
        # A face's boundary edges: the crease pieces along its squares' sides.
        face_edges = {}
        for sq, f in self.face_of.items():
            axis, corner, s = sq
            u, v = others(axis)
            for b in (u, v):
                for start in (corner, add(corner, unit(others_of(axis, b)))):
                    seg = (b, start)
                    if seg in self.edge_of:
                        face_edges.setdefault(f, set()).add(self.edge_of[seg])
        for f, es in face_edges.items():
            es = sorted(es)
            for i, a in enumerate(es):
                for b in es[i + 1:]:
                    la, ha, _ = self.edges[a]
                    lb, hb, _ = self.edges[b]
                    if {la, ha} & {lb, hb}:
                        continue
                    d2 = self._distance2(la, ha, lb, hb)
                    if d2 < MIN_FEATURE * MIN_FEATURE:
                        out.append(("gap", (self.point(la), self.point(ha)), (self.point(lb), self.point(hb)), d2))
        return sorted(set(out), key=repr)

    def _distance2(self, la, ha, lb, hb):
        d2 = 0
        for a in range(3):
            lo1, hi1 = self.grid.coords[a][la[a]], self.grid.coords[a][ha[a]]
            lo2, hi2 = self.grid.coords[a][lb[a]], self.grid.coords[a][hb[a]]
            gap = max(0, lo2 - hi1, lo1 - hi2)
            d2 += gap * gap
        return d2


def others_of(axis, b):
    """The in-plane axis of a square on `axis` that is not `b`."""
    return 3 - axis - b


def measure(grid, cells):
    return Measured(grid, cells)


def check_input(name, grid, cells):
    m = Measured(grid, cells)
    if not cells:
        raise ModelError(f"input {name} is empty")
    if not m.manifold():
        raise ModelError(f"input {name} is not manifold at {m.nonmanifold[0]}")
    bodies = m.body_list()
    if len(bodies) != 1:
        raise ModelError(f"input {name} is {len(bodies)} bodies, not one")
    if m.thin():
        raise ModelError(f"input {name} is thin at {m.thin()[0]}")
    return m


def boolean(op, a, b):
    """The kernel's answer for `a op b`, each a list of boxes (their union is
    the body). A dict: outcome ('bodies', 'empty', 'nonmanifold', 'thin'),
    problems (every one that applies), bodies (when manifold and not empty),
    where (non-manifold places and thin places), pinched (face pinches)."""
    if op not in OPS:
        raise ModelError(f"unknown operation {op!r}")
    if not a or not b:
        raise ModelError("each input needs at least one box")
    grid = Grid([a, b])
    ca, cb = grid.cells(a), grid.cells(b)
    check_input("A", grid, ca)
    check_input("B", grid, cb)
    cells = {"union": ca | cb, "subtract": ca - cb, "intersect": ca & cb}[op]
    return judge_cells(grid, frozenset(cells))


def solid(boxes):
    """A lone solid measured as the kernel would see it (for inputs and
    feeding results back): the same dict as `boolean`."""
    grid = Grid([boxes])
    return judge_cells(grid, grid.cells(boxes))


def judge_cells(grid, cells):
    m = Measured(grid, cells)
    problems, where = [], {}
    if not cells:
        problems.append("empty")
    if m.nonmanifold:
        problems.append("nonmanifold")
        where["nonmanifold"] = m.nonmanifold
    # Thin is judged on a manifold result only: at a non-manifold place
    # edges of two pieces cross, which is that problem, not a thin one.
    thin = m.thin() if cells and not m.nonmanifold else []
    if thin:
        problems.append("thin")
        where["thin"] = thin
    result = {
        "outcome": problems[0] if problems else "bodies",
        "problems": problems,
        "where": where,
        "pinched": m.pinched(),
    }
    if cells and not m.nonmanifold:
        result["bodies"] = m.body_list()
    else:
        result["bodies"] = []
    return result


def boxes_of(grid, cells):
    """The result as boxes again (one per cell), to feed back as an input."""
    return [tuple(grid.coords[a][c[a]] for a in range(3)) + tuple(grid.coords[a][c[a] + 1] for a in range(3)) for c in sorted(cells)]
