//! `sketch_outline_of` (what the app's `sketch_outline` call answers) over
//! JSON lines, for the independent Python model in
//! `prototypes/oracle/sketch_outline.py` to check against (testing hunt 3b,
//! `prototypes/oracle/sketch_outline_check.py`).
//!
//! Each input line is one sketch, `{ "lines": [[ax, ay, bx, by]…],
//! "circles": [[cx, cy, r]…], "arcs": [[sx, sy, ex, ey, cx, cy]…] }` (any
//! may be left out), every number given as its double's 64 bits
//! (`f64::to_bits`): serde_json's own decimal reading may land a bit away
//! from the double nearest the decimal, which would compare the kernel on a
//! different sketch. Each output line is `{ "ok": SketchOutlineOut }` or
//! `{ "err": ApiError }`, its numbers the shortest decimal that reads back
//! as the same double (serde_json writes them exactly).
//!
//! cargo run --example sketch_outline_json < sketches.jsonl

use fission_kernel::{sketch_outline_of, ArcIn, CircleIn, LineIn};
use serde::Deserialize;
use std::io::{BufRead, Write};

#[derive(Deserialize)]
struct Sketch {
    #[serde(default)]
    lines: Vec<[u64; 4]>,
    #[serde(default)]
    circles: Vec<[u64; 3]>,
    #[serde(default)]
    arcs: Vec<[u64; 6]>,
}

fn xy(bits: &[u64]) -> [f64; 2] {
    [f64::from_bits(bits[0]), f64::from_bits(bits[1])]
}

fn main() {
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for (n, line) in std::io::stdin().lock().lines().enumerate() {
        let line = line.expect("stdin is readable");
        let sketch: Sketch = serde_json::from_str(&line).unwrap_or_else(|e| panic!("input line {}: {e}", n + 1));
        let lines: Vec<LineIn> = sketch.lines.iter().map(|l| LineIn { a: xy(&l[0..2]), b: xy(&l[2..4]) }).collect();
        let circles: Vec<CircleIn> = sketch.circles.iter().map(|c| CircleIn { centre: xy(&c[0..2]), radius: f64::from_bits(c[2]) }).collect();
        let arcs: Vec<ArcIn> = sketch.arcs.iter().map(|a| ArcIn { start: xy(&a[0..2]), end: xy(&a[2..4]), centre: xy(&a[4..6]) }).collect();
        let answer = match sketch_outline_of(&lines, &circles, &arcs) {
            Ok(outline) => serde_json::json!({ "ok": outline }),
            Err(e) => serde_json::json!({ "err": e }),
        };
        writeln!(out, "{answer}").expect("stdout is writable");
    }
}
