"""Whether a profile loop crosses itself, worked out at 50 digits, the
oracle's referee when OpenCascade calls a shape invalid.

OpenCascade's validity check (BRepCheck_Analyzer) works to its own
tolerance, 1e-7 mm: two edges that come within it anywhere but their
shared vertex count as intersecting, so it flags very sharp corners and
nearly tangent pieces that never actually meet. This finds the points
where two pieces of a loop really meet, from the doubles the kernel was
given, independently of both kernels: the kernel promises none apart from
the corners consecutive pieces share, to within LINEAR of them
(kernel/src/ops/profile.rs, which also wants non-neighbours at least
1 um apart; that rule is not checked here).

Pieces (pieces.py's ("line", a, b) and ("arc", a, centre, b, r, phi)) are
rebuilt exactly: an arc of bulge t over chord a->b has its centre on the
chord's perpendicular bisector, (1 - t^2) / (4 t) chords to the left of the
midpoint (pieces.py's working), radius |c - a|. Then
- line-line: a + s (b - a) = p + u (q - p), two linear equations;
- line-circle: |a + s (b - a) - c|^2 = r^2, a quadratic in s;
- circle-circle: the radical line, then the line-circle quadratic.
A point on a piece's circle is on its arc when it is on the arc's side of
the chord: the chord a->b cuts the circle into two arcs, one each side;
counter-clockwise (t > 0) from a to b runs on its right.
"""

from mpmath import mp, mpf, sqrt

mp.dps = 50

# The kernel's linear tolerance (kernel/src/tolerance.rs LINEAR, 10 nm):
# two neighbours meeting within it of the corner they share meet at that
# corner as far as the kernel can tell, so it is not a crossing (the
# owner's decision on issue #138, a meeting 0.44 nm from the corner).
# Non-neighbours get no such allowance anywhere.
LINEAR = mpf("1e-5")


def _x(v):
    return mpf(float(v))


def exact_pieces(ring):
    """The loop's pieces at 50 digits: ("line", a, b) or
    ("arc", a, b, centre, r2, t) with r2 the radius squared; a circle is
    one arc of t = 0 (a full turn), on every point of its circle."""
    (kind, p), = ring.items()
    if kind == "Circle":
        (cx, cy), r = (_x(v) for v in p["c"]), _x(p["r"])
        c = (cx, cy)
        return [("arc", (cx + r, cy), (cx + r, cy), c, r * r, mpf(0))]
    pts = [(_x(x), _x(y)) for x, y in p["pts"]]
    bulges = [_x(b) for b in p["bulges"]] or [mpf(0)] * len(pts)
    out = []
    for i, a in enumerate(pts):
        b, t = pts[(i + 1) % len(pts)], bulges[i]
        if t == 0:
            out.append(("line", a, b))
            continue
        dx, dy = b[0] - a[0], b[1] - a[1]
        k = (1 - t * t) / (4 * t)
        c = ((a[0] + b[0]) / 2 - dy * k, (a[1] + b[1]) / 2 + dx * k)
        out.append(("arc", a, b, c, (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2, t))
    return out


def _cross(o, p, q):
    return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])


def _on(piece, x, eps):
    """Whether point x (already on the piece's line or circle) is on it."""
    a, b = piece[1], piece[2]
    if piece[0] == "line":
        d = (b[0] - a[0], b[1] - a[1])
        s = ((x[0] - a[0]) * d[0] + (x[1] - a[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2)
        return -eps <= s <= 1 + eps
    if piece[5] == 0:
        return True  # a whole circle
    side = _cross(a, b, x)
    scale = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + piece[4]
    return side * piece[5] <= eps * scale  # right of the chord when t > 0


def _line_circle(a, b, c, r2):
    """Points where the line through a, b meets the circle (c, r2)."""
    d = (b[0] - a[0], b[1] - a[1])
    f = (a[0] - c[0], a[1] - c[1])
    qa = d[0] ** 2 + d[1] ** 2
    qb = 2 * (f[0] * d[0] + f[1] * d[1])
    qc = f[0] ** 2 + f[1] ** 2 - r2
    disc = qb * qb - 4 * qa * qc
    if disc < 0:
        return []
    root = sqrt(disc)
    return [(a[0] + s * d[0], a[1] + s * d[1]) for s in ((-qb - root) / (2 * qa), (-qb + root) / (2 * qa))]


def meeting_points(p, q):
    """Every point where pieces p and q meet (both on their own extent)."""
    if p[0] == "line" and q[0] == "line":
        a, b, c, d = p[1], p[2], q[1], q[2]
        den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])
        if den == 0:
            return []  # parallel; overlapping collinear pieces are the clearance rule's
        s = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den
        cands = [(a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]))]
    elif p[0] == "line" or q[0] == "line":
        line, arc = (p, q) if p[0] == "line" else (q, p)
        cands = _line_circle(line[1], line[2], arc[3], arc[4])
    else:
        (c1, r1), (c2, r2) = (p[3], p[4]), (q[3], q[4])
        dx, dy = c2[0] - c1[0], c2[1] - c1[1]
        dd = dx * dx + dy * dy
        if dd == 0:
            return []  # same centre: equal circles overlap (clearance rule), else never meet
        # Radical line: points x with |x - c1|^2 - r1 = |x - c2|^2 - r2.
        k = (r1 - r2 + dd) / (2 * dd)
        m = (c1[0] + k * dx, c1[1] + k * dy)
        cands = _line_circle(m, (m[0] - dy, m[1] + dx), c1, r1)
    eps = mpf(10) ** -40
    return [x for x in cands if _on(p, x, eps) and _on(q, x, eps)]


def crossings(shape):
    """Points where two pieces of an extrude's profile meet other than at
    the corner two neighbours in one loop share, as (loop, piece, loop,
    piece, (x, y)): empty when every loop is simple and no two loops meet."""
    (_, p), = shape.items()
    loops = [exact_pieces(r) for r in [p["outer"]] + p["holes"]]
    flat = [(k, i, piece) for k, ps in enumerate(loops) for i, piece in enumerate(ps)]
    found = []
    for m, (k, i, a) in enumerate(flat):
        for kk, j, b in flat[m + 1:]:
            n, shared = len(loops[k]), []
            if k == kk and j == i + 1:
                shared.append(a[2])
            if k == kk and i == 0 and j == n - 1:
                shared.append(b[2])
            for x in meeting_points(a, b):
                if all((x[0] - s[0]) ** 2 + (x[1] - s[1]) ** 2 > LINEAR ** 2 for s in shared):
                    found.append((k, i, kk, j, (float(x[0]), float(x[1]))))
    return found
