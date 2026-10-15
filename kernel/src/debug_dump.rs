//! Failure dumps: when a geometry check fails, write the shapes as STL plus
//! a self-contained HTML viewer with the problem edges and faces in red, so
//! the failure can be seen rather than imagined.

use crate::tessellate::{tessellate, TessOptions};
use crate::topology::Body;
use crate::validate::{validate, ValidationError};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Writes `<dir>/<name>/` containing one ASCII STL per body and `index.html`.
/// Problems are taken from `validate` on each body. Returns the folder.
pub fn dump(dir: &Path, name: &str, bodies: &[(&str, &Body)], note: &str) -> std::io::Result<PathBuf> {
    let out = dir.join(sanitize(name));
    std::fs::create_dir_all(&out)?;
    let mut scene = String::from("[");
    for (i, (label, body)) in bodies.iter().enumerate() {
        let errors = validate(body).err().unwrap_or_default();
        let bad_edges: Vec<usize> = errors.iter().flat_map(ValidationError::edges).collect();
        let bad_faces: Vec<usize> = errors.iter().flat_map(ValidationError::faces).collect();
        let messages: Vec<String> = errors.iter().map(|e| e.to_string()).collect();
        let (positions, triangles, faces, edges) = match tessellate(body, &TessOptions::DISPLAY) {
            Ok(m) => {
                std::fs::write(out.join(format!("{}.stl", sanitize(label))), stl(label, &m))?;
                let pos: Vec<f64> = m.positions.iter().flat_map(|p| p.to_array()).collect();
                let tris: Vec<u32> = m.triangles.iter().flatten().copied().collect();
                let edges: Vec<Vec<f64>> = m
                    .edge_polylines
                    .iter()
                    .map(|poly| poly.iter().flat_map(|&v| m.positions[v as usize].to_array()).collect())
                    .collect();
                (pos, tris, m.triangle_face.clone(), edges)
            }
            // No mesh: show the edges sampled straight from their curves.
            Err(_) => {
                let edges = body
                    .edges
                    .iter()
                    .map(|e| (0..=16).flat_map(|k| e.point_at(k as f64 / 16.0).to_array()).collect())
                    .collect();
                (vec![], vec![], vec![], edges)
            }
        };
        if i > 0 {
            scene.push(',');
        }
        let _ = write!(
            scene,
            r#"{{"label":{},"positions":{},"triangles":{},"faces":{},"edges":{},"badEdges":{},"badFaces":{},"errors":{}}}"#,
            json_str(label),
            json_nums(&positions),
            json_list(&triangles),
            json_list(&faces),
            json_array(edges.iter().map(|e| json_nums(e))),
            json_list(&bad_edges),
            json_list(&bad_faces),
            json_array(messages.iter().map(|m| json_str(m))),
        );
    }
    scene.push(']');
    std::fs::write(out.join("index.html"), VIEWER.replace("__NOTE__", &json_str(note)).replace("__SCENE__", &scene))?;
    Ok(out)
}

/// ASCII STL of a mesh.
pub fn stl(name: &str, m: &crate::mesh::Mesh) -> String {
    let mut s = format!("solid {}\n", sanitize(name));
    for t in 0..m.triangles.len() {
        let [a, b, c] = m.triangle(t);
        let n = (b - a).cross(c - a).normalize_or_zero();
        let _ = writeln!(s, "  facet normal {:e} {:e} {:e}\n    outer loop", n.x, n.y, n.z);
        for p in [a, b, c] {
            let _ = writeln!(s, "      vertex {:e} {:e} {:e}", p.x, p.y, p.z);
        }
        s.push_str("    endloop\n  endfacet\n");
    }
    let _ = writeln!(s, "endsolid {}", sanitize(name));
    s
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
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
    let items: Vec<String> = v.iter().map(|x| if x.is_finite() { format!("{x:e}") } else { "null".into() }).collect();
    format!("[{}]", items.join(","))
}

fn json_array(items: impl Iterator<Item = String>) -> String {
    format!("[{}]", items.collect::<Vec<_>>().join(","))
}

fn json_list<T: ToString>(v: &[T]) -> String {
    format!("[{}]", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))
}

const VIEWER: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Failure dump</title>
<style>
  html,body{margin:0;height:100%;background:#14161a;color:#e6e8eb;font:13px system-ui,sans-serif}
  #info{position:absolute;top:0;left:0;max-width:44em;padding:12px;background:#1c1f24e6;max-height:45%;overflow:auto}
  #info h1{font-size:15px;margin:0 0 6px} .bad{color:#ff6b6b} pre{white-space:pre-wrap;margin:4px 0}
</style>
<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.170.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.170.0/examples/jsm/"}}</script>
</head><body><div id="info"></div>
<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
const note = __NOTE__;
const scene = __SCENE__;
const info = document.getElementById("info");
info.innerHTML = "<h1>Failure dump</h1><pre></pre>";
info.querySelector("pre").textContent = note;
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const world = new THREE.Scene();
world.background = new THREE.Color(0x14161a);
world.add(new THREE.AmbientLight(0xffffff, 0.6));
const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(1, -2, 3); world.add(light);
const group = new THREE.Group(); world.add(group);
const colours = [0x9aa7b8, 0x7fb3d5, 0xc39bd3, 0xf0b27a];
scene.forEach((b, i) => {
  const h = document.createElement("div");
  h.innerHTML = `<b></b> ${b.errors.length ? `<span class="bad">${b.errors.length} problem(s)</span>` : "valid"}`;
  h.querySelector("b").textContent = b.label;
  info.appendChild(h);
  for (const e of b.errors) { const p = document.createElement("pre"); p.className = "bad"; p.textContent = e; info.appendChild(p); }
  if (b.triangles.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(b.positions, 3));
    const bad = new Set(b.badFaces);
    const cols = [];
    for (let v = 0; v < b.positions.length / 3; v++) cols.push(0, 0, 0);
    const idx = [], badIdx = [];
    b.faces.forEach((f, t) => (bad.has(f) ? badIdx : idx).push(...b.triangles.slice(3 * t, 3 * t + 3)));
    const add = (index, colour, opacity) => {
      const gg = g.clone(); gg.setIndex(index); gg.computeVertexNormals();
      group.add(new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ color: colour, side: THREE.DoubleSide, transparent: opacity < 1, opacity, polygonOffset: true, polygonOffsetFactor: 1 })));
    };
    add(idx, colours[i % colours.length], 0.85);
    if (badIdx.length) add(badIdx, 0xff3b3b, 1);
  }
  const badE = new Set(b.badEdges);
  b.edges.forEach((pts, e) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: badE.has(e) ? 0xff3b3b : 0x0b0c0e, linewidth: badE.has(e) ? 3 : 1 })));
  });
});
const box = new THREE.Box3().setFromObject(group);
const centre = box.getCenter(new THREE.Vector3()), size = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, size / 1000, size * 100);
camera.position.copy(centre).add(new THREE.Vector3(0.6, -0.8, 0.55).multiplyScalar(size * 1.2));
const controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(centre);
addEventListener("resize", () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(world, camera); });
</script></body></html>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::hand_cube;

    #[test]
    fn dump_of_a_broken_cube_highlights_the_problem() {
        // Move vertex 7 off its edges: validate names vertex 7 and the three
        // edges meeting there. A cube mesh has 12 triangles → 12 STL facets.
        let mut broken = hand_cube();
        broken.vertices[7].point.z += 0.5;
        let dir = std::env::temp_dir().join(format!("fission-dump-test-{}", std::process::id()));
        let out = dump(&dir, "broken cube", &[("before", &hand_cube()), ("after", &broken)], "moved vertex 7").unwrap();
        let html = std::fs::read_to_string(out.join("index.html")).unwrap();
        assert!(html.contains("vertex 7"), "error message missing");
        assert!(html.contains("moved vertex 7"), "note missing");
        assert!(!html.contains("__SCENE__") && !html.contains("__NOTE__"));
        let stl = std::fs::read_to_string(out.join("after.stl")).unwrap();
        assert_eq!(stl.matches("facet normal").count(), 12);
        assert!(out.join("before.stl").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn json_strings_are_escaped() {
        // A quote, a backslash, a newline and a closing script tag must not
        // break out of the embedded data.
        assert_eq!(json_str("a\"b\\c\n</script>"), r#""a\"b\\c\n\u003c/script>""#);
        assert_eq!(json_nums(&[1.5, f64::NAN]), "[1.5e0,null]");
    }
}
