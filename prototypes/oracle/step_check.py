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
  doesn't);
- each such pcurve moved by a whole turn where it was fitted a turn away
  from its neighbours on a cylinder or sphere (FixShifted; step 29b3: two
  good bodies of the stateful harness, a 121° arc 28 long and a 517 m
  column, read invalid with nearly twice their volume until it was on).
  A shift by the period is the same curve on the same surface, so it can
  neither turn a face nor reorder a loop.
Every other repair is switched off (`_heal`).

A body passes when:
- the file holds one solid of one shell (the writer refuses anything else);
- BRepCheck says it is valid;
- no vertex and no edge needed a tolerance above the file's own
  uncertainty, LINEAR (10 nm): OpenCascade widens a vertex's tolerance to
  reach every curve that should pass through it, and an edge's to reach its
  faces, so this holds the body to the kernel's own rule (every vertex on
  its edges and every edge on its faces within LINEAR).

For a good body far out, which OpenCascade misreads (it loses digits
there), `home` gives an exact copy of the same body moved home;
compare.py's `step_issues` judges with it. `RADIUS` finds the radii, for
compare.py's small-feature limit.

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
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.GeomAbs import GeomAbs_Plane
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.ShapeBuild import ShapeBuild_ReShape
from OCP.ShapeFix import ShapeFix_Face
from OCP.STEPControl import STEPControl_Reader
from OCP.StepToTopoDS import StepToTopoDS_Builder
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX, TopAbs_WIRE
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
WIRE_ON = {"FixEdgeCurvesMode", "FixAddPCurveMode", "FixSameParameterMode", "FixShiftedMode"}


@dataclass
class Report:
    problems: list = field(default_factory=list)
    volume: float = 0.0
    area: float = 0.0
    faces: int = 0
    vertex_tolerance: float = 0.0  # the largest OpenCascade needed
    edge_tolerance: float = 0.0
    cancelled: float = 0.0  # `cancelled_area`

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


def _area(shape):
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, props)
    return abs(props.Mass())


def cancelled_area(shape):
    """How much loop area cancels on the body's flat faces with holes: for
    each, every loop's own area added up, less the face's. OpenCascade
    integrates such a face loop by loop (outline, then each hole taken
    off), so its rounding grows with the loops' areas, not the face's: a
    60 x 62 mm frame 0.0011 mm wide (#282) is 3,720 mm2 less 3,719.73, and
    OpenCascade read its volume 3.7 times the slack off, a file with every
    corner the nearest double to exact still up to 1,000 times. 0 for a
    face with one loop, so only such faces get room for it (compare.py's
    `cancelled_room`). A hole walked the wrong way adds to its face's area
    instead of cancelling, so it gives no room either."""
    total = 0.0
    for f in _shapes(shape, TopAbs_FACE):
        face = TopoDS.Face(f)
        wires = list(_shapes(face, TopAbs_WIRE))
        surface = BRepAdaptor_Surface(face)
        if len(wires) < 2 or surface.GetType() != GeomAbs_Plane:
            continue
        loops = 0.0
        for w in wires:
            made = BRepBuilderAPI_MakeFace(surface.Plane(), TopoDS.Wire(w), True)
            if not made.IsDone():
                return 0.0  # a loop OpenCascade can't fill: no room at all
            loops += _area(made.Face())
        total += max(loops - _area(face), 0.0)
    return total


def check(path):
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
    for name, value in (("vertex", report.vertex_tolerance), ("edge", report.edge_tolerance)):
        if value > LINEAR * (1 + 1e-9):
            report.problems.append(f"{'an' if name == 'edge' else 'a'} {name} needed tolerance {value:.3g} mm, above LINEAR ({LINEAR})")
    volume, area = GProp_GProps(), GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, volume)
    BRepGProp.SurfaceProperties_s(shape, area)
    report.volume, report.area = volume.Mass(), area.Mass()
    report.faces = len(list(_shapes(shape, TopAbs_FACE)))
    report.cancelled = cancelled_area(shape)
    return report


def check_text(text):
    """`check` of a file's text (OpenCascade reads only from a path)."""
    fd, path = tempfile.mkstemp(suffix=".step")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        return check(path)
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



# A circle's or round surface's radius (group 2).
RADIUS = re.compile(r"^(#\d+ = (?:CIRCLE|CYLINDRICAL_SURFACE|SPHERICAL_SURFACE)\('',#\d+,)([^,()]+)\);$", re.M)


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
