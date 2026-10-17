"""Profile loops as pieces for the OpenCascade oracle, worked out here
independently of both kernels (plain Python, no OpenCascade, so CI can
test it): ("line", a, b), ("arc", a, centre, b, r, phi) or
("circle", centre, r).

An arc of bulge b = tan(phi/4) over chord a->b turns phi = 4 atan b. By
the half-angle formulas sin(phi/2) = 2b/(1 + b^2) and cos(phi/2) =
(1 - b^2)/(1 + b^2), so its radius |ab| / (2 |sin(phi/2)|) is
|ab| (1 + b^2) / (4 |b|), and its centre sits on the chord's perpendicular
bisector, r cos(phi/2) = |ab| (1 - b^2) / (4 b) to the left (right when
negative). Written with b, not phi: for a nearly whole circle phi/2 is
within 1e-8 of pi, and sin(phi/2) taken from phi kept only half its digits
(a 60 m arc came out 0.7 mm short, issue #73)."""

import math


def pieces(ring):
    (kind, p), = ring.items()
    if kind == "Circle":
        return [("circle", tuple(float(v) for v in p["c"]), float(p["r"]))]
    pts = [(float(x), float(y)) for x, y in p["pts"]]
    bulges = [float(b) for b in p["bulges"]] or [0.0] * len(pts)
    out = []
    for i, a in enumerate(pts):
        b, bulge = pts[(i + 1) % len(pts)], bulges[i]
        if bulge == 0.0:
            out.append(("line", a, b))
            continue
        dx, dy = b[0] - a[0], b[1] - a[1]
        chord = math.sqrt(dx * dx + dy * dy)
        r = chord * (1.0 + bulge * bulge) / (4.0 * abs(bulge))
        k = (1.0 - bulge * bulge) / (4.0 * bulge)
        centre = ((a[0] + b[0]) / 2.0 - dy * k, (a[1] + b[1]) / 2.0 + dx * k)
        out.append(("arc", a, centre, b, r, 4.0 * math.atan(bulge)))
    return out


def signed_area(ps):
    """Twice the signed area: shoelace plus each arc's circular segment."""
    twice = 0.0
    for piece in ps:
        if piece[0] == "circle":
            return 2.0 * math.pi * piece[2] ** 2
        a, b = piece[1], piece[-1] if piece[0] == "line" else piece[3]
        twice += a[0] * b[1] - b[0] * a[1]
        if piece[0] == "arc":
            r, phi = piece[4], piece[5]
            twice += r * r * (phi - math.sin(phi))
    return twice
