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

Usage: python step_check.py body.step [more.step ...] (exit status 1 if
any fails). Needs: pip install cadquery-ocp
"""

import sys
from dataclasses import dataclass, field

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
    return report


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
