//! Failure dumps: when a geometry check fails, write the shapes as STL plus
//! a self-contained HTML viewer with the problems in red, so the failure can
//! be seen rather than imagined.
//!
//! In red: faces and edges a `validate` error names, vertices off their
//! edges, every face of an inside-out shell, and the display mesh's open or
//! flipped edges. The page draws with a plain 2D canvas and loads nothing,
//! so it opens offline, straight from a downloaded nightly result. It works
//! relative to the middle of the scene in doubles, so a body 100 km out is
//! drawn as sharply as one at the origin.
//!
//! `checked` calls `dump_invalid` before panicking, so every invalid body a
//! test build produces leaves a dump in `kernel/target/failure-dumps/`.

use crate::mesh::{Mesh, MeshError};
use crate::tessellate::{tessellate, TessOptions};
use crate::topology::Body;
use crate::validate::{validate, ValidationError};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Most dumps `dump_invalid` writes per process: a shrinking random test
/// can produce hundreds of invalid bodies, and the first few tell the story.
pub const MAX_AUTOMATIC_DUMPS: usize = 20;

/// Writes `<dir>/<name>/` containing one ASCII STL per body and `index.html`.
/// Problems are taken from `validate` on each body. Returns the folder.
pub fn dump(
    dir: &Path,
    name: &str,
    bodies: &[(&str, &Body)],
    note: &str,
) -> std::io::Result<PathBuf> {
    let out = dir.join(sanitize(name));
    std::fs::create_dir_all(&out)?;
    let mut items = Vec::new();
    for (label, body) in bodies {
        let (json, mesh) = body_scene(label, body);
        if let Some(m) = mesh {
            std::fs::write(out.join(format!("{}.stl", sanitize(label))), stl(label, &m))?;
        }
        items.push(json);
    }
    let scene = json_array(items.into_iter());
    std::fs::write(
        out.join("index.html"),
        VIEWER
            .replace("__NOTE__", &json_str(note))
            .replace("__SCENE__", &scene),
    )?;
    Ok(out)
}

/// The dump `checked` writes for an invalid body: into
/// `kernel/target/failure-dumps/invalid-body-<hash>/`, named after the body
/// and its errors so the same failure is written once. None after
/// MAX_AUTOMATIC_DUMPS, on WebAssembly (no files), or if writing fails.
pub fn dump_invalid(body: &Body, errors: &str) -> Option<PathBuf> {
    if cfg!(target_arch = "wasm32") {
        return None;
    }
    static WRITTEN: AtomicUsize = AtomicUsize::new(0);
    dump_invalid_in(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("target/failure-dumps"),
        &WRITTEN,
        body,
        errors,
    )
}

/// `dump_invalid` into `dir`, counting new dumps in `written`.
fn dump_invalid_in(
    dir: &Path,
    written: &AtomicUsize,
    body: &Body,
    errors: &str,
) -> Option<PathBuf> {
    let hash = fnv1a(format!("{errors}{body:?}").as_bytes());
    let out = dir.join(format!("invalid-body-{hash:016x}"));
    if out.join("index.html").exists() {
        return Some(out);
    }
    if written.fetch_add(1, Ordering::Relaxed) >= MAX_AUTOMATIC_DUMPS {
        return None;
    }
    let note = format!("A kernel operation produced an invalid body:\n{errors}");
    dump(
        dir,
        &format!("invalid-body-{hash:016x}"),
        &[("invalid body", body)],
        &note,
    )
    .ok()
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, &b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    })
}

/// Points per edge when an edge is drawn from its curve.
const CURVE_SAMPLES: usize = 16;

/// One body's entry in the page's scene, and its mesh if it has one.
fn body_scene(label: &str, body: &Body) -> (String, Option<Mesh>) {
    let errors = validate(body).err().unwrap_or_default();
    let mut bad_edges: Vec<usize> = errors.iter().flat_map(ValidationError::edges).collect();
    let mut bad_faces: Vec<usize> = errors.iter().flat_map(ValidationError::faces).collect();
    for e in &errors {
        if let ValidationError::InsideOut { shell, .. } = *e {
            bad_faces.extend(body.shells.get(shell).map_or(&[][..], |s| &s.faces[..]));
        }
    }
    bad_edges.sort_unstable();
    bad_edges.dedup();
    bad_faces.sort_unstable();
    bad_faces.dedup();
    let mut vertex_ids: Vec<usize> = errors.iter().flat_map(ValidationError::vertices).collect();
    vertex_ids.sort_unstable();
    vertex_ids.dedup();
    let mut bad_vertices: Vec<f64> = Vec::new();
    for v in vertex_ids {
        if let Some(vx) = body.vertices.get(v) {
            bad_vertices.extend(vx.point.to_array());
        }
    }
    let messages: Vec<String> = errors.iter().map(|e| e.to_string()).collect();
    // A body with dangling references can't be tessellated or even sampled
    // safely; it is listed with its errors and nothing drawn.
    let sound = !errors
        .iter()
        .any(|e| matches!(e, ValidationError::DanglingReference { .. }));
    let mesh = if sound {
        tessellate(body, &TessOptions::DISPLAY).ok()
    } else {
        None
    };
    type Drawing = (Vec<f64>, Vec<u32>, Vec<usize>, Vec<Vec<f64>>, Vec<f64>);
    let (positions, triangles, faces, edges, problems): Drawing = match &mesh {
        Some(m) => (
            m.positions.iter().flat_map(|p| p.to_array()).collect(),
            m.triangles.iter().flatten().copied().collect(),
            m.triangle_face.clone(),
            m.edge_polylines
                .iter()
                .map(|poly| {
                    poly.iter()
                        .flat_map(|&v| m.positions[v as usize].to_array())
                        .collect()
                })
                .collect(),
            mesh_problems(m),
        ),
        // No mesh: show the edges sampled straight from their curves.
        None if sound => (
            vec![],
            vec![],
            vec![],
            body.edges
                .iter()
                .map(|e| {
                    (0..=CURVE_SAMPLES)
                        .flat_map(|k| e.point_at(k as f64 / CURVE_SAMPLES as f64).to_array())
                        .collect()
                })
                .collect(),
            vec![],
        ),
        None => (vec![], vec![], vec![], vec![], vec![]),
    };
    // The named edges' own curves, sampled: the mesh draws an edge through
    // its vertices, so a vertex off its edge only shows as a gap here.
    let curves: Vec<Vec<f64>> = if sound {
        bad_edges
            .iter()
            .filter_map(|&e| body.edges.get(e))
            .map(|e| {
                (0..=CURVE_SAMPLES)
                    .flat_map(|k| e.point_at(k as f64 / CURVE_SAMPLES as f64).to_array())
                    .collect()
            })
            .collect()
    } else {
        vec![]
    };
    let json = format!(
        r#"{{"label":{},"positions":{},"triangles":{},"faces":{},"edges":{},"badEdges":{},"badCurves":{},"badFaces":{},"badVertices":{},"meshProblems":{},"errors":{}}}"#,
        json_str(label),
        json_nums(&positions),
        json_list(&triangles),
        json_list(&faces),
        json_array(edges.iter().map(|e| json_nums(e))),
        json_list(&bad_edges),
        json_array(curves.iter().map(|c| json_nums(c))),
        json_list(&bad_faces),
        json_nums(&bad_vertices),
        json_nums(&problems),
        json_array(messages.iter().map(|m| json_str(m))),
    );
    (json, mesh)
}

/// The mesh's open or flipped edges as segments, six coordinates each.
fn mesh_problems(m: &Mesh) -> Vec<f64> {
    let Err(errs) = m.check_closed() else {
        return vec![];
    };
    errs.iter()
        .flat_map(|e| {
            let (MeshError::OpenEdge { a, b, .. } | MeshError::FlippedTriangles { a, b }) = *e;
            [m.positions[a as usize], m.positions[b as usize]]
        })
        .flat_map(|p| p.to_array())
        .collect()
}

/// ASCII STL of a mesh.
pub fn stl(name: &str, m: &crate::mesh::Mesh) -> String {
    let mut s = format!("solid {}\n", sanitize(name));
    for t in 0..m.triangles.len() {
        let [a, b, c] = m.triangle(t);
        let n = (b - a).cross(c - a).normalize_or_zero();
        let _ = writeln!(
            s,
            "  facet normal {:e} {:e} {:e}\n    outer loop",
            n.x, n.y, n.z
        );
        for p in [a, b, c] {
            let _ = writeln!(s, "      vertex {:e} {:e} {:e}", p.x, p.y, p.z);
        }
        s.push_str("    endloop\n  endfacet\n");
    }
    let _ = writeln!(s, "endsolid {}", sanitize(name));
    s
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            '<' => out.push_str("\\u003c"), // keep "</script>" out of the page
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn json_nums(v: &[f64]) -> String {
    let items: Vec<String> = v
        .iter()
        .map(|x| {
            if x.is_finite() {
                format!("{x:e}")
            } else {
                "null".into()
            }
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn json_array(items: impl Iterator<Item = String>) -> String {
    format!("[{}]", items.collect::<Vec<_>>().join(","))
}

fn json_list<T: ToString>(v: &[T]) -> String {
    format!(
        "[{}]",
        v.iter()
            .map(|x| x.to_string())
            .collect::<Vec<_>>()
            .join(",")
    )
}

const VIEWER: &str = r##"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Failure dump</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#14161a;color:#e6e8eb;font:13px system-ui,sans-serif}
  canvas{display:block;width:100vw;height:100vh;touch-action:none;cursor:grab}
  #info{position:absolute;top:0;left:0;max-width:44em;padding:12px;background:#1c1f24e6;max-height:45%;overflow:auto}
  #info h1{font-size:15px;margin:0 0 6px} .bad{color:#ff6b6b} pre{white-space:pre-wrap;margin:4px 0}
  #tools{position:absolute;bottom:12px;left:12px;display:flex;gap:6px}
  button{font:inherit;color:inherit;background:#2a2e35;border:1px solid #444a53;border-radius:4px;padding:4px 10px;cursor:pointer}
</style>
</head><body><canvas id="view"></canvas><div id="info"></div>
<div id="tools"><button id="faces">Hide faces</button><button id="home">Reset view</button></div>
<script>
"use strict";
const note = __NOTE__;
const scene = __SCENE__;
const RED = [255, 59, 59], colours = [[154, 167, 184], [127, 179, 213], [195, 155, 211], [240, 178, 122]];
const info = document.getElementById("info");
info.innerHTML = "<h1>Failure dump</h1><pre></pre><div>Drag to turn, wheel to zoom. Red: the problems listed; dashed red: where a named edge's curve really runs.</div>";
info.querySelector("pre").textContent = note;
for (const b of scene) {
  const h = document.createElement("div");
  h.innerHTML = `<b></b> ${b.errors.length ? `<span class="bad">${b.errors.length} problem(s)</span>` : "valid"}`;
  h.querySelector("b").textContent = b.label;
  info.appendChild(h);
  for (const e of b.errors) { const p = document.createElement("pre"); p.className = "bad"; p.textContent = e; info.appendChild(p); }
  if (b.meshProblems.length) { const p = document.createElement("pre"); p.className = "bad"; p.textContent = `${b.meshProblems.length / 6} open or flipped mesh edge(s), drawn in red`; info.appendChild(p); }
}
// Everything relative to the middle of the scene, in doubles.
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
const visit = (a) => { for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) { lo[i % 3] = Math.min(lo[i % 3], a[i]); hi[i % 3] = Math.max(hi[i % 3], a[i]); } };
for (const b of scene) { visit(b.positions); b.edges.forEach(visit); visit(b.badVertices); visit(b.meshProblems); }
const centre = lo.map((l, i) => (Number.isFinite(l) ? (l + hi[i]) / 2 : 0));
const radius = Math.max(Number.isFinite(lo[0]) ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 : 1, 1e-9);
const points = (a) => { const out = []; for (let i = 0; i + 2 < a.length; i += 3) out.push([a[i] - centre[0], a[i + 1] - centre[1], a[i + 2] - centre[2]]); return out; };
const tris = [], lines = [], dots = [];
scene.forEach((b, i) => {
  const p = points(b.positions), bad = new Set(b.badFaces), badE = new Set(b.badEdges);
  b.faces.forEach((f, t) => tris.push({ v: [0, 1, 2].map((k) => p[b.triangles[3 * t + k]]), colour: bad.has(f) ? RED : colours[i % colours.length], bad: bad.has(f) }));
  b.edges.forEach((e, k) => lines.push({ v: points(e), bad: badE.has(k) }));
  for (const c of b.badCurves) lines.push({ v: points(c), bad: true, dashed: true });
  const m = points(b.meshProblems);
  for (let k = 0; k + 1 < m.length; k += 2) lines.push({ v: [m[k], m[k + 1]], bad: true });
  dots.push(...points(b.badVertices));
});
lines.sort((a, b) => a.bad - b.bad); // red on top
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const view = { yaw: -1.1, pitch: 0.5, zoom: 1, faces: true };
const home = () => Object.assign(view, { yaw: -1.1, pitch: 0.5, zoom: 1 });
const canvas = document.getElementById("view"), ctx = canvas.getContext("2d");
function draw() {
  const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#14161a"; ctx.fillRect(0, 0, W, H);
  // Z up: the eye looks back along e; r is screen right, u screen up.
  const cp = Math.cos(view.pitch), e = [cp * Math.cos(view.yaw), cp * Math.sin(view.yaw), Math.sin(view.pitch)];
  const r = [-Math.sin(view.yaw), Math.cos(view.yaw), 0], u = cross(e, r);
  const s = (view.zoom * 0.45 * Math.min(W, H)) / radius;
  const xy = (p) => [W / 2 + s * dot(p, r), H / 2 - s * dot(p, u)];
  let drawn = 0;
  if (view.faces) {
    const order = tris.map((t) => ({ t, d: dot(t.v[0], e) + dot(t.v[1], e) + dot(t.v[2], e) })).sort((a, b) => a.d - b.d);
    for (const { t } of order) {
      if (t.v.some((p) => !p)) continue;
      const n = cross(sub(t.v[1], t.v[0]), sub(t.v[2], t.v[0])), len = Math.hypot(...n) || 1;
      const light = (t.bad ? 0.55 : 0.35) + (t.bad ? 0.45 : 0.65) * Math.abs(dot(n, e) / len);
      const c = `rgb(${t.colour.map((x) => Math.round(x * light)).join(",")})`;
      const [a, b, d] = t.v.map(xy);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...d); ctx.closePath();
      ctx.fillStyle = c; ctx.strokeStyle = c; ctx.lineWidth = 0.5; ctx.fill(); ctx.stroke();
      drawn++;
    }
  }
  for (const l of lines) {
    const pts = l.v.filter((p) => p.every(Number.isFinite));
    if (pts.length < 2) continue;
    ctx.beginPath(); ctx.moveTo(...xy(pts[0])); for (const p of pts.slice(1)) ctx.lineTo(...xy(p));
    ctx.strokeStyle = l.bad ? "rgb(255,59,59)" : view.faces ? "#0b0c0e" : "#9aa7b8"; ctx.lineWidth = l.bad ? 3 : 1;
    ctx.setLineDash(l.dashed ? [6, 5] : []); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.fillStyle = "rgb(255,59,59)";
  for (const p of dots) { ctx.beginPath(); ctx.arc(...xy(p), 5, 0, 2 * Math.PI); ctx.fill(); }
  document.body.dataset.triangles = String(drawn);
}
let drag = null;
canvas.addEventListener("pointerdown", (ev) => { drag = [ev.clientX, ev.clientY]; canvas.setPointerCapture(ev.pointerId); });
canvas.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  view.yaw -= (ev.clientX - drag[0]) * 0.01;
  view.pitch = Math.max(-1.55, Math.min(1.55, view.pitch + (ev.clientY - drag[1]) * 0.01));
  drag = [ev.clientX, ev.clientY]; draw();
});
canvas.addEventListener("pointerup", () => { drag = null; });
canvas.addEventListener("wheel", (ev) => { ev.preventDefault(); view.zoom *= Math.exp(-ev.deltaY * 0.001); draw(); }, { passive: false });
document.getElementById("faces").onclick = (ev) => { view.faces = !view.faces; ev.target.textContent = view.faces ? "Hide faces" : "Show faces"; draw(); };
document.getElementById("home").onclick = () => { home(); draw(); };
addEventListener("resize", draw);
draw();
</script></body></html>
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::hand_cube;
    use glam::DVec3;
    use serde_json::Value;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fission-dump-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// The scene data embedded in a dump's page.
    fn scene_of(out: &Path) -> Vec<Value> {
        let html = std::fs::read_to_string(out.join("index.html")).unwrap();
        let start = html.find("const scene = ").unwrap() + "const scene = ".len();
        let end = start + html[start..].find(";\n").unwrap();
        serde_json::from_str::<Value>(&html[start..end])
            .unwrap()
            .as_array()
            .unwrap()
            .clone()
    }

    fn numbers(v: &Value) -> Vec<f64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap())
            .collect()
    }

    #[test]
    fn a_moved_vertex_is_marked_with_its_three_edges() {
        // hand_cube makes its edges in face order, numbering each new vertex
        // pair as it first appears:
        //   face 0 (0,2,3,1): e0 = 0–2, e1 = 2–3, e2 = 1–3, e3 = 0–1
        //   face 1 (4,5,7,6): e4 = 4–5, e5 = 5–7, e6 = 6–7, e7 = 4–6
        //   face 2 (0,1,5,4): e8 = 1–5, e9 = 0–4
        //   face 3 (2,6,7,3): e10 = 2–6, e11 = 3–7
        // Vertex 7 = (1,1,1) is on edges 5, 6 and 11. Lifting it by 0.5 to
        // (1,1,1.5) leaves those three lines where they were, so it is off
        // exactly those edges; no face is named (the edges stay on theirs).
        let mut broken = hand_cube();
        broken.vertices[7].point.z += 0.5;
        let dir = temp_dir("vertex");
        let out = dump(
            &dir,
            "broken cube",
            &[("before", &hand_cube()), ("after", &broken)],
            "moved vertex 7",
        )
        .unwrap();
        let scene = scene_of(&out);
        assert_eq!(scene.len(), 2);
        let (before, after) = (&scene[0], &scene[1]);
        assert_eq!(before["errors"].as_array().unwrap().len(), 0);
        assert_eq!(numbers(&before["badEdges"]), Vec::<f64>::new());
        assert_eq!(numbers(&after["badEdges"]), [5.0, 6.0, 11.0]);
        assert_eq!(numbers(&after["badFaces"]), Vec::<f64>::new());
        assert_eq!(numbers(&after["badVertices"]), [1.0, 1.0, 1.5]);
        // Each named edge's own curve, from the line it was made as: edge 5
        // runs from vertex 5 (1,0,1) to 7's old place (1,1,1); 6 from 6
        // (0,1,1) to (1,1,1); 11 from 3 (1,1,0) to (1,1,1). Ends only.
        let ends: Vec<Vec<f64>> = after["badCurves"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let c = numbers(c);
                assert_eq!(c.len(), 3 * 17);
                [&c[..3], &c[c.len() - 3..]].concat()
            })
            .collect();
        assert_eq!(
            ends,
            [
                vec![1.0, 0.0, 1.0, 1.0, 1.0, 1.0],
                vec![0.0, 1.0, 1.0, 1.0, 1.0, 1.0],
                vec![1.0, 1.0, 0.0, 1.0, 1.0, 1.0]
            ]
        );
        assert_eq!(after["errors"].as_array().unwrap().len(), 3);
        assert!(after["errors"][0].as_str().unwrap().contains("vertex 7"));
        let html = std::fs::read_to_string(out.join("index.html")).unwrap();
        assert!(html.contains("moved vertex 7"), "note missing");
        assert!(!html.contains("__SCENE__") && !html.contains("__NOTE__"));
        // Nothing is fetched: the page works offline.
        assert!(!html.contains("http"), "the viewer must not load anything");
        // A cube mesh has 12 triangles → 12 STL facets.
        let stl = std::fs::read_to_string(out.join("after.stl")).unwrap();
        assert_eq!(stl.matches("facet normal").count(), 12);
        assert!(out.join("before.stl").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_inside_out_cube_is_red_all_over() {
        // Every face and loop reversed: only the volume (−1) is wrong, and it
        // belongs to the whole shell, so all six faces are marked.
        let mut b = hand_cube();
        for f in &mut b.faces {
            f.sense = !f.sense;
            for l in &mut f.loops {
                l.coedges.reverse();
                for c in &mut l.coedges {
                    c.reversed = !c.reversed;
                }
            }
        }
        let dir = temp_dir("inside-out");
        let scene = scene_of(&dump(&dir, "x", &[("cube", &b)], "").unwrap());
        assert_eq!(
            numbers(&scene[0]["badFaces"]),
            [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_and_flipped_mesh_edges_by_hand() {
        // The tetrahedron 0 = origin, 1 = x, 2 = y, 3 = z, its four
        // triangles counter-clockwise from outside. Closed: nothing to mark.
        let mut m = Mesh {
            positions: vec![DVec3::ZERO, DVec3::X, DVec3::Y, DVec3::Z],
            triangles: vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            triangle_face: vec![0; 4],
            ..Mesh::default()
        };
        assert_eq!(mesh_problems(&m), Vec::<f64>::new());
        // Flip the slanted face (1,2,3): each of its edges is now run the
        // same way by it and its neighbour, so 1–2, 1–3 and 2–3 are marked.
        m.triangles[3] = [1, 3, 2];
        let segs = mesh_problems(&m);
        // (Each written lower point first, largest segment first.)
        assert_eq!(
            segments(&segs),
            [
                [0.0, 1.0, 0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0, 1.0, 0.0]
            ]
        );
        // Remove it instead: the same three edges are open, each used once.
        m.triangles.pop();
        m.triangle_face.pop();
        assert_eq!(segments(&mesh_problems(&m)), segments(&segs));
    }

    /// Segments as sorted endpoint pairs, sorted, for comparison.
    fn segments(v: &[f64]) -> Vec<[f64; 6]> {
        let mut out: Vec<[f64; 6]> = v
            .chunks(6)
            .map(|c| {
                let (a, b) = ([c[0], c[1], c[2]], [c[3], c[4], c[5]]);
                let (a, b) = if a.partial_cmp(&b) == Some(std::cmp::Ordering::Greater) {
                    (b, a)
                } else {
                    (a, b)
                };
                [a[0], a[1], a[2], b[0], b[1], b[2]]
            })
            .collect();
        out.sort_by(|a, b| b.partial_cmp(a).unwrap());
        out
    }

    #[test]
    fn dangling_references_are_listed_not_drawn() {
        // A coedge pointing at edge 999 of 12: validate stops at that, and
        // the dump must neither panic nor try to mesh or sample it.
        let mut b = hand_cube();
        b.faces[2].loops[0].coedges[0].edge = 999;
        let dir = temp_dir("dangling");
        let out = dump(&dir, "x", &[("bad", &b)], "").unwrap();
        let scene = scene_of(&out);
        assert!(scene[0]["errors"][0].as_str().unwrap().contains("dangling"));
        assert_eq!(numbers(&scene[0]["positions"]).len(), 0);
        assert_eq!(scene[0]["edges"].as_array().unwrap().len(), 0);
        assert!(!out.join("bad.stl").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn far_away_coordinates_keep_every_digit() {
        // A unit cube moved to x = 5e7 + 0.3 (a double: ulp there is 7.5e-9).
        // The page reads every number back to the same double, so the viewer
        // can subtract the scene's middle and draw it sharply.
        let mut b = hand_cube();
        for v in &mut b.vertices {
            v.point.x += 5e7 + 0.3;
        }
        for e in &mut b.edges {
            if let crate::geom::Curve::Line { origin, .. } = &mut e.curve {
                origin.x += 5e7 + 0.3;
            }
        }
        for f in &mut b.faces {
            if let crate::geom::Surface::Plane { origin, .. } = &mut f.surface {
                origin.x += 5e7 + 0.3;
            }
        }
        let dir = temp_dir("far");
        let scene = scene_of(&dump(&dir, "x", &[("far", &b)], "").unwrap());
        assert_eq!(scene[0]["errors"].as_array().unwrap().len(), 0);
        let xs: Vec<f64> = numbers(&scene[0]["positions"])
            .into_iter()
            .step_by(3)
            .collect();
        assert!(
            xs.contains(&(5e7 + 0.3)) && xs.contains(&(5e7 + 1.3)),
            "{xs:?}"
        );
        assert!(xs.iter().all(|&x| x == 5e7 + 0.3 || x == 5e7 + 1.3));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn automatic_dumps_are_written_once_and_capped() {
        let dir = temp_dir("auto");
        let written = AtomicUsize::new(0);
        let mut b = hand_cube();
        b.vertices[7].point.z += 0.5;
        let first = dump_invalid_in(&dir, &written, &b, "e").unwrap();
        assert!(first.join("index.html").exists());
        // The same body and errors again: the same folder, not counted.
        assert_eq!(
            dump_invalid_in(&dir, &written, &b, "e"),
            Some(first.clone())
        );
        assert_eq!(written.load(Ordering::Relaxed), 1);
        // Different errors text → a different folder, until the cap.
        for k in 1..MAX_AUTOMATIC_DUMPS {
            let p = dump_invalid_in(&dir, &written, &b, &format!("e{k}")).unwrap();
            assert_ne!(p, first);
        }
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            MAX_AUTOMATIC_DUMPS
        );
        assert_eq!(dump_invalid_in(&dir, &written, &b, "one too many"), None);
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            MAX_AUTOMATIC_DUMPS
        );
        // Already written ones are still found after the cap.
        assert_eq!(dump_invalid_in(&dir, &written, &b, "e"), Some(first));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn json_strings_are_escaped() {
        // A quote, a backslash, a newline and a closing script tag must not
        // break out of the embedded data.
        assert_eq!(
            json_str("a\"b\\c\n</script>"),
            r#""a\"b\\c\n\u003c/script>""#
        );
        assert_eq!(json_nums(&[1.5, f64::NAN]), "[1.5e0,null]");
    }
}
