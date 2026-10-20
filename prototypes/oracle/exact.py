"""Exact volume and area of the harness's shapes, the oracle's referee.

OpenCascade integrates mass properties numerically in the coordinates it is
given, so it rounds too, sometimes far more than Panosolid (a profile drawn
100 km out lost 3x of its volume in it). When Panosolid and OpenCascade
disagree, this says who is right: every shape the harness makes (box,
cylinder, sphere, extruded profile of lines and arcs with holes) has a
closed-form volume and area, worked out here at 50 significant digits from
the exact values of the doubles the harness wrote, independently of both
kernels (no shared code with kernel/src/mass.rs, which integrates the
B-rep's edges instead).

Formulas:
- Box w x d x h: V = wdh, S = 2(wd + wh + dh).
- Cylinder r, h: V = pi r^2 h, S = 2 pi r^2 + 2 pi r h.
- Sphere r: V = 4/3 pi r^3, S = 4 pi r^2.
- Extrusion of profile area A (outer minus holes), perimeter P (all loops),
  distance d: V = A d, S = 2A + P d. A loop's area is the shoelace sum over
  its corners plus, for each arc of bulge b over chord c (turning angle
  phi = 4 atan b, radius r = c / (2 |sin(phi/2)|)), the circular segment
  r^2 (phi - sin phi) / 2 on the side the bulge's sign says; its length is
  r |phi|. A circle is pi r^2 and 2 pi r.

`judge` turns three numbers into a verdict; tested in test_exact.py.
"""

from mpmath import mp, mpf, atan, sin, sqrt, pi

mp.dps = 50


def _x(v):
    # float() first: the harness writes each double as its shortest repr,
    # and the shape Panosolid built is that double, not the decimal.
    return mpf(float(v))


def loop(ring):
    """(|area|, perimeter) of one profile loop."""
    (kind, p), = ring.items()
    if kind == "Circle":
        r = _x(p["r"])
        return pi * r * r, 2 * pi * r
    pts = [(_x(x), _x(y)) for x, y in p["pts"]]
    bulges = [_x(b) for b in p["bulges"]] or [mpf(0)] * len(pts)
    ox, oy = pts[0]
    twice, perimeter = mpf(0), mpf(0)
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        twice += (a[0] - ox) * (b[1] - oy) - (b[0] - ox) * (a[1] - oy)
        chord = sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)
        if bulges[i] == 0:
            perimeter += chord
            continue
        phi = 4 * atan(bulges[i])
        r = chord / (2 * abs(sin(phi / 2)))
        twice += r * r * (phi - sin(phi))
        perimeter += r * abs(phi)
    return abs(twice) / 2, perimeter


def volume_area(shape):
    """(V, S) at 50 digits for a harness shape, or None for an unknown kind."""
    (kind, p), = shape.items()
    if kind == "Box":
        w, d, h = _x(p["w"]), _x(p["d"]), _x(p["h"])
        return w * d * h, 2 * (w * d + w * h + d * h)
    if kind == "Cylinder":
        r, h = _x(p["r"]), _x(p["h"])
        return pi * r * r * h, 2 * pi * r * r + 2 * pi * r * h
    if kind == "Sphere":
        r = _x(p["r"])
        return 4 * pi * r ** 3 / 3, 4 * pi * r * r
    if kind == "Extrude":
        d = _x(p["dist"])
        outer = loop(p["outer"])
        holes = [loop(h) for h in p["holes"]]
        area = outer[0] - sum(h[0] for h in holes)
        perimeter = outer[1] + sum(h[1] for h in holes)
        return area * d, 2 * area + perimeter * d
    return None


def judge(fission, occ, exact, allowed):
    """Who is off for one quantity: 'agree' (Panosolid within `allowed` of the
    reference), 'fission' (Panosolid is off: a finding), or 'occ' (Panosolid
    matches the exact value and only OpenCascade is off: its own rounding,
    not counted). The reference is the exact value when there is one, else
    OpenCascade's."""
    if exact is None:
        return "agree" if abs(fission - occ) <= allowed else "fission"
    if abs(mpf(fission) - exact) > allowed:
        return "fission"
    return "occ" if abs(mpf(occ) - exact) > allowed else "agree"
