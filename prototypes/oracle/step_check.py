"""OpenCascade reads a STEP file the kernel wrote (kernel/src/step_write.rs)
and judges the body in it (step 29b): its own validity checker
(BRepCheck), the tolerances it needed to make the body hang together, and
its volume, area and face count.

OpenCascade's normal STEP reader repairs what it reads (ShapeFix): it
turned a face that had been flipped inside out back round, and reordered
a broken loop, and then called the body valid with the right volume. That
would hide exactly the faults this oracle is for, so the file is
translated without it (StepToTopoDS straight from the file's
MANIFOLD_SOLID_BREP) and given only the two things OpenCascade needs that
a STEP file doesn't carry, neither of which can turn a face or reorder a
loop:
- each edge's 2D curve on each of its faces ("pcurves", which
  OpenCascade's faces need; STEP gives the 3D curve only), fitted and
  measured (SameParameter), which also sets each edge's tolerance to how
  far its 3D curve is from its faces;
- a seam on a face of a cylinder or sphere that has none (OpenCascade
  needs a seam on every face that wraps round; the kernel, like STEP,
  doesn't).
Every other repair is switched off (`_heal`).

A body passes when:
- the file holds one solid of one shell (the writer refuses anything else);
- BRepCheck says it is valid;
- no vertex and no edge needed a tolerance above the file's own
  uncertainty, LINEAR (10 nm): OpenCascade widens a vertex's tolerance to
  reach every curve that should pass through it, and an edge's to reach its
  faces, so this holds the body to the kernel's own rule (every vertex on
  its edges and every edge on its faces within LINEAR).

For bodies OpenCascade misreads though they are good (far out, or with
radii of a few µm), `home` and `scaled` give exact copies of the same body
that it reads better; compare.py's `step_issues` judges with them.

Usage: python step_check.py body.step [more.step ...] (exit status 1 if
any fails). Needs: pip install cadquery-ocp
"""

import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from fractions import Fraction

from OCP.BRep import BRep_Tool
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.ShapeBuild import ShapeBuild_ReShape
from OCP.ShapeFix import ShapeFix_Face
from OCP.STEPControl import STEPControl_Reader
from OCP.StepToTopoDS import StepToTopoDS_Builder
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.Transfer import Transfer_TransientProcess

LINEAR = 1e-5  # kernel/src/tolerance.rs; the writer puts it in the file too

# Every mode of OpenCascade's face and wire repairs, so each is set on
# purpose: the two kept on (see the top of the file) and everything else off.
FACE_MODES = ["FixAddNaturalBoundMode", "FixIntersectingWiresMode", "FixLoopWiresMode", "FixMissingSeamMode",
              "FixOrientationMode", "FixPeriodicDegeneratedMode", "FixSmallAreaWireMode", "FixSplitFaceMode",
              "FixWireMode", "RemoveSmallAreaFaceMode"]
FACE_ON = {"FixMissingSeamMode", "FixWireMode"}  # FixWireMode only runs the wire modes below
WIRE_MODES = ["FixAddCurve3dMode", "FixAddPCurveMode", "FixConnectedMode", "FixDegeneratedMode", "FixEdgeCurvesMode",
              "FixGaps2dMode", "FixGaps3dMode", "FixIntersectingEdgesMode", "FixLackingMode",
              "FixNonAdjacentIntersectingEdgesMode", "FixNotchedEdgesMode", "FixRemoveCurve3dMode",
              "FixRemovePCurveMode", "FixReorderMode", "FixReversed2dMode", "FixSameParameterMode", "FixSeamMode",
              "FixSelfIntersectingEdgeMode", "FixSelfIntersectionMode", "FixShiftedMode", "FixSmallMode",
              "FixTailMode", "FixVertexToleranceMode", "ModifyRemoveLoopMode"]
WIRE_ON = {"FixEdgeCurvesMode", "FixAddPCurveMode", "FixSameParameterMode"}


@dataclass
class Report:
    problems: list = field(default_factory=list)
    volume: float = 0.0
    area: float = 0.0
    faces: int = 0
    vertex_tolerance: float = 0.0  # the largest OpenCascade needed
    edge_tolerance: float = 0.0

    @property
    def ok(self):
        return not self.problems


def _shapes(shape, kind):
    ex = TopExp_Explorer(shape, kind)
    while ex.More():
        yield ex.Current()
        ex.Next()


def _translate(path):
    """The file's solids, translated as written (no repairs), or why not."""
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        return None, "OpenCascade couldn't read the file"
    model = reader.StepModel()
    process = Transfer_TransientProcess()
    process.SetModel(model)
    solids = []
    for k in range(1, model.NbEntities() + 1):
        entity = model.Value(k)
        if entity.DynamicType().Name() == "StepShape_ManifoldSolidBrep":
            builder = StepToTopoDS_Builder()
            builder.Init(entity, process)
            if not builder.IsDone():
                return None, f"OpenCascade couldn't translate entity #{k}"
            solids.append(builder.Value())
    if len(solids) != 1:
        return None, f"expected one MANIFOLD_SOLID_BREP, found {len(solids)}"
    return solids[0], None


def _heal(shape):
    """Only pcurves (fitted and measured) and missing seams; see the top."""
    context = ShapeBuild_ReShape()
    for face in _shapes(shape, TopAbs_FACE):
        fix = ShapeFix_Face(TopoDS.Face(face))
        fix.SetContext(context)
        fix.SetPrecision(1e-7)  # OpenCascade's own confusion distance, below LINEAR
        fix.AutoCorrectPrecisionMode = False
        for mode in FACE_MODES:
            setattr(fix, mode, 1 if mode in FACE_ON else 0)
        wire = fix.FixWireTool()
        for mode in WIRE_MODES:
            setattr(wire, mode, 1 if mode in WIRE_ON else 0)
        fix.Perform()
    return context.Apply(shape)


def _largest_tolerance(shape, kind, cast):
    return max((BRep_Tool.Tolerance_s(cast(s)) for s in _shapes(shape, kind)), default=0.0)


def check(path, scale=1.0):
    """The checks above on the body in the file at `path`. `scale` says the
    file is a body blown up by that factor (`scaled`): the tolerance limit
    is LINEAR times it, and the report's numbers are given back in the
    body's own units."""
    report = Report()
    raw, why = _translate(path)
    if raw is None:
        report.problems.append(why)
        return report
    if raw.ShapeType() != TopAbs_SOLID or len(list(_shapes(raw, TopAbs_SHELL))) != 1:
        report.problems.append("not one solid of one shell")
    # The vertex tolerances as translated (the repairs can only widen them).
    report.vertex_tolerance = _largest_tolerance(raw, TopAbs_VERTEX, TopoDS.Vertex)
    shape = _heal(raw)
    report.vertex_tolerance = max(report.vertex_tolerance, _largest_tolerance(shape, TopAbs_VERTEX, TopoDS.Vertex))
    report.edge_tolerance = _largest_tolerance(shape, TopAbs_EDGE, TopoDS.Edge)
    if not BRepCheck_Analyzer(shape).IsValid():
        bad = [k for k, f in enumerate(_shapes(shape, TopAbs_FACE)) if not BRepCheck_Analyzer(f).IsValid()]
        report.problems.append("BRepCheck: invalid" + (f" (faces {bad}, counted in file order)" if bad else ""))
    # 1 + 1e-9: the tolerance OpenCascade sets is the file's LINEAR read back
    # from decimal, which may land an ulp or so either side.
    # A power of two scales exactly, so dividing back is exact too.
    report.vertex_tolerance /= scale
    report.edge_tolerance /= scale
    for name, value in (("vertex", report.vertex_tolerance), ("edge", report.edge_tolerance)):
        if value > LINEAR * (1 + 1e-9):
            report.problems.append(f"{'an' if name == 'edge' else 'a'} {name} needed tolerance {value:.3g} mm, above LINEAR ({LINEAR})")
    volume, area = GProp_GProps(), GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, volume)
    BRepGProp.SurfaceProperties_s(shape, area)
    report.volume, report.area = volume.Mass() / scale ** 3, area.Mass() / scale ** 2
    report.faces = len(list(_shapes(shape, TopAbs_FACE)))
    return report


def check_text(text, scale=1.0):
    """`check` of a file's text (OpenCascade reads only from a path)."""
    fd, path = tempfile.mkstemp(suffix=".step")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        return check(path, scale)
    finally:
        os.unlink(path)


POINT = re.compile(r"^#(\d+) = CARTESIAN_POINT\('',\(([^,()]+),([^,()]+),([^,()]+)\)\);$", re.M)


def _part21(x):
    """A Part 21 real, as kernel/src/step_write.rs's `real` writes it: the
    shortest decimal that reads back as `x`, with a decimal point and an
    upper-case exponent."""
    s = repr(x)
    if "e" in s:
        m, e = s.split("e")
        return f"{m}{'' if '.' in m else '.'}E{e}"
    return s


def home(text):
    """The same body moved home: every CARTESIAN_POINT less a shift, so its
    volume and area can be measured where OpenCascade doesn't lose digits
    (it integrates in the coordinates it is given: a profile 50-100 km out
    lost up to 3x of its volume, compare.py's `centred`). Per axis the shift
    is the middle of the corners' (VERTEX_POINTs') span, used only where the
    part is farther out than its size (the corners' largest span; nearer in
    there are no digits to win) and only if it moves every point in the file
    exactly (checked in fractions; Sterbenz makes it so for a part farther
    out than its own size), so the moved file is the same body, not a
    rounded copy; directions, radii and the topology don't change. Returns
    the text and the shift (0.0 on an axis left alone)."""
    points = {m.group(1): [float(m.group(k)) for k in (2, 3, 4)] for m in POINT.finditer(text)}
    corners = [points[k] for k in re.findall(r"VERTEX_POINT\('',#(\d+)\)", text) if k in points]
    shift = [0.0, 0.0, 0.0]
    if not corners:
        return text, tuple(shift)
    size = max(max(p[a] for p in corners) - min(p[a] for p in corners) for a in range(3))
    for axis in range(3):
        xs = [p[axis] for p in corners]
        c = (min(xs) + max(xs)) / 2.0
        if abs(c) > size and all(Fraction(p[axis]) - Fraction(c) == Fraction(p[axis] - c) for p in points.values()):
            shift[axis] = c
    moved = POINT.sub(lambda m: f"#{m.group(1)} = CARTESIAN_POINT('',(" + ",".join(
        _part21(float(m.group(k + 2)) - shift[k]) for k in range(3)) + "));", text)
    return moved, tuple(shift)



RADIUS = re.compile(r"^(#\d+ = (?:CIRCLE|CYLINDRICAL_SURFACE|SPHERICAL_SURFACE)\('',#\d+,)([^,()]+)\);$", re.M)
UNCERTAINTY = re.compile(r"LENGTH_MEASURE\(([^()]+)\)")
SMALLEST = 1.0  # mm: the smallest radius `scaled` blows a body up to


def scaled(text):
    """The same body blown up by a power of two, 2^k with the smallest k >= 0
    that makes its smallest radius at least SMALLEST (1 mm), and the factor
    (1.0, and the text unchanged, when it has no radius below that). Every
    length in the file is multiplied: the points, the circles' and
    surfaces' radii and the uncertainty; directions and the topology stay.
    Multiplying by a power of two is exact, so this is the same body at
    another size, every distance and gap in it scaled alike.

    Why (found by 29b2's first runs): OpenCascade lost the side of a
    cylinder of radius 1 µm whose top circle's centre sat 3e-9 mm off the
    axis (rounding, 3,000 times inside LINEAR) and read it as a valid solid
    of a third of its volume; its normal reader with every repair did the
    same. Its working precisions are absolute (1e-7 mm), made for parts of
    millimetres and more, and the kernel's smallest features are 1 µm
    (MIN_FEATURE). The same cylinder blown up 1024 times reads valid, with
    its exact volume."""
    radii = [float(m.group(2)) for m in RADIUS.finditer(text)]
    factor = 1.0
    while radii and min(radii) * factor < SMALLEST:
        factor *= 2.0
    if factor == 1.0:
        return text, factor
    t = POINT.sub(lambda m: f"#{m.group(1)} = CARTESIAN_POINT('',(" + ",".join(
        _part21(float(m.group(k)) * factor) for k in (2, 3, 4)) + "));", text)
    t = RADIUS.sub(lambda m: f"{m.group(1)}{_part21(float(m.group(2)) * factor)});", t)
    return UNCERTAINTY.sub(lambda m: f"LENGTH_MEASURE({_part21(float(m.group(1)) * factor)})", t), factor

def main():
    failed = 0
    for path in sys.argv[1:]:
        r = check(path)
        failed += not r.ok
        verdict = "ok" if r.ok else "FAILED: " + "; ".join(r.problems)
        print(f"{path}: {verdict}; volume {r.volume!r}, area {r.area!r}, {r.faces} faces, "
              f"tolerances vertex {r.vertex_tolerance:.3g}, edge {r.edge_tolerance:.3g}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
