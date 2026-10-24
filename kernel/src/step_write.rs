//! A minimal STEP writer (step 29b): one body as an AP214 manifold solid,
//! so OpenCascade can read the kernel's actual bodies, check them with its
//! own validity checker and measure them (`prototypes/oracle/step_check.py`),
//! instead of only rebuilding each shape itself. Also step 70's first piece.
//!
//! The file (ISO 10303-21, "Part 21") is a header and a list of numbered
//! entities, each one line, written children first so no line refers
//! forward:
//! - the product a STEP reader looks for (`PRODUCT` … `PRODUCT_DEFINITION_SHAPE`);
//! - the units (millimetres, radians, steradians) and `LINEAR` as the
//!   uncertainty, in one `GEOMETRIC_REPRESENTATION_CONTEXT`;
//! - per vertex a `CARTESIAN_POINT` and a `VERTEX_POINT`;
//! - per edge its curve (`LINE` through a point with a unit `VECTOR`, or
//!   `CIRCLE` on an `AXIS2_PLACEMENT_3D`) and an `EDGE_CURVE` from its
//!   start vertex to its end vertex, same sense as the curve (edges run
//!   along their curve over t0 < t1; a full circle has one vertex at both
//!   ends, as here);
//! - per face its surface (`PLANE`, `CYLINDRICAL_SURFACE`,
//!   `SPHERICAL_SURFACE`, each on an `AXIS2_PLACEMENT_3D`), per loop an
//!   `ORIENTED_EDGE` for each coedge (`.F.` when reversed), an `EDGE_LOOP`
//!   and a `FACE_BOUND` (`.T.`), and an `ADVANCED_FACE` with the face's
//!   `sense` as its same_sense;
//! - a `CLOSED_SHELL`, the `MANIFOLD_SOLID_BREP`, and the
//!   `ADVANCED_BREP_SHAPE_REPRESENTATION` tied to the product.
//!
//! Why the kernel's own conventions carry over unchanged (ISO 10303-42):
//! an `AXIS2_PLACEMENT_3D` (location, axis, ref_direction) has its third
//! axis axis × ref_direction, exactly the kernel's `y_dir = normal ×
//! x_dir`, so a plane is location + u ref + v (axis × ref), a circle is
//! centre + r (cos t ref + sin t (axis × ref)), a cylinder adds v axis, and
//! a sphere's u and v are longitude and latitude: each the kernel's own
//! parametrisation (`geom/curve.rs`, `geom/surface.rs`). The cylinder's and
//! sphere's surface normals point away from the axis and centre in both. A
//! face's normal is its surface's flipped when same_sense is false (the
//! kernel's `sense`), and in a closed shell of a solid it points out; a
//! `FACE_BOUND` with orientation true runs with the face's interior on its
//! left seen from the side its normal points to, which is the kernel's loop
//! rule, outer loops and holes alike, so no loop needs to be told apart as
//! the outer one (`FACE_OUTER_BOUND` is optional).
//!
//! Every number is written as the shortest decimal that reads back as the
//! same double (Rust's `{:?}`), with the decimal point and upper-case `E`
//! Part 21 needs, so the file holds exactly the body's own coordinates.
//!
//! Only valid bodies are written (`validate`): an invalid one is refused
//! with `InvalidInput`, so the oracle never reports a fault the kernel
//! already knew about. A body of more than one shell (a void, from step 34)
//! is refused too, with words, until booleans need `BREP_WITH_VOIDS`.
//! Ellipses join at step 37b.

use crate::geom::{Curve, Surface};
use crate::ops::KernelError;
use crate::tolerance::LINEAR;
use crate::topology::Body;
use glam::DVec3;

/// The body as a STEP AP214 file, or why it can't be written.
pub fn write(body: &Body) -> Result<String, KernelError> {
    if let Err(errs) = crate::validate::validate(body) {
        let list: Vec<String> = errs.iter().map(|e| e.to_string()).collect();
        return Err(refuse(format!("only a valid body can be written to STEP: {}", list.join("; "))));
    }
    if body.shells.is_empty() {
        return Err(refuse("an empty body can't be written to STEP".to_string()));
    }
    if body.shells.len() != 1 {
        return Err(refuse(format!(
            "a body of {} shells can't be written to STEP yet (one shell only until booleans make voids)",
            body.shells.len()
        )));
    }
    let mut w = Writer::default();
    let data = w.body(body);
    if w.non_finite {
        // Unreachable for a valid body; kept so no input writes a bad file.
        return Err(refuse("a body with a non-finite number can't be written to STEP".to_string()));
    }
    let mut out = String::from(HEADER);
    for (k, line) in data.iter().enumerate() {
        out.push_str(&format!("#{} = {line};\n", k + 1));
    }
    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    Ok(out)
}

fn refuse(message: String) -> KernelError {
    KernelError::InvalidInput { inputs: vec![], message }
}

/// No time stamp or author, so the same body always gives the same file.
const HEADER: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('SpindleLabs body'),'2;1');
FILE_NAME('body.step','',(''),(''),'SpindleLabs','SpindleLabs','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
";

#[derive(Default)]
struct Writer {
    lines: Vec<String>,
    non_finite: bool,
}

impl Writer {
    /// Adds an entity and returns its number.
    fn add(&mut self, entity: String) -> usize {
        self.lines.push(entity);
        self.lines.len()
    }

    fn real(&mut self, x: f64) -> String {
        self.non_finite |= !x.is_finite();
        real(x)
    }

    fn triple(&mut self, v: DVec3) -> String {
        format!("({},{},{})", self.real(v.x), self.real(v.y), self.real(v.z))
    }

    fn point(&mut self, p: DVec3) -> usize {
        let t = self.triple(p);
        self.add(format!("CARTESIAN_POINT('',{t})"))
    }

    fn direction(&mut self, d: DVec3) -> usize {
        let t = self.triple(d);
        self.add(format!("DIRECTION('',{t})"))
    }

    fn placement(&mut self, origin: DVec3, axis: DVec3, x_dir: DVec3) -> usize {
        let (p, a, x) = (self.point(origin), self.direction(axis), self.direction(x_dir));
        self.add(format!("AXIS2_PLACEMENT_3D('',#{p},#{a},#{x})"))
    }

    fn curve(&mut self, curve: &Curve) -> usize {
        match *curve {
            Curve::Line { origin, dir } => {
                let (p, d) = (self.point(origin), self.direction(dir));
                let v = self.add(format!("VECTOR('',#{d},1.0)"));
                self.add(format!("LINE('',#{p},#{v})"))
            }
            Curve::Circle { center, axis, x_dir, radius } => {
                let a = self.placement(center, axis, x_dir);
                let r = self.real(radius);
                self.add(format!("CIRCLE('',#{a},{r})"))
            }
        }
    }

    fn surface(&mut self, surface: &Surface) -> usize {
        match *surface {
            Surface::Plane { origin, normal, x_dir } => {
                let a = self.placement(origin, normal, x_dir);
                self.add(format!("PLANE('',#{a})"))
            }
            Surface::Cylinder { origin, axis, x_dir, radius } => {
                let a = self.placement(origin, axis, x_dir);
                let r = self.real(radius);
                self.add(format!("CYLINDRICAL_SURFACE('',#{a},{r})"))
            }
            Surface::Sphere { center, axis, x_dir, radius } => {
                let a = self.placement(center, axis, x_dir);
                let r = self.real(radius);
                self.add(format!("SPHERICAL_SURFACE('',#{a},{r})"))
            }
        }
    }

    /// Every entity of a valid one-shell body, in order.
    fn body(&mut self, body: &Body) -> Vec<String> {
        let app = self.add("APPLICATION_CONTEXT('automotive design')".to_string());
        self.add(format!("APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#{app})"));
        let pc = self.add(format!("PRODUCT_CONTEXT('',#{app},'mechanical')"));
        let product = self.add(format!("PRODUCT('body','body','',(#{pc}))"));
        let pdc = self.add(format!("PRODUCT_DEFINITION_CONTEXT('part definition',#{app},'design')"));
        let pdf = self.add(format!("PRODUCT_DEFINITION_FORMATION('','',#{product})"));
        let pd = self.add(format!("PRODUCT_DEFINITION('design','',#{pdf},#{pdc})"));
        let pds = self.add(format!("PRODUCT_DEFINITION_SHAPE('','',#{pd})"));
        let mm = self.add("(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))".to_string());
        let rad = self.add("(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))".to_string());
        let sr = self.add("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())".to_string());
        let unc = self.add(format!(
            "UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE({}),#{mm},'distance_accuracy_value','SpindleLabs LINEAR')",
            real(LINEAR)
        ));
        let ctx = self.add(format!(
            "(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#{unc})) \
             GLOBAL_UNIT_ASSIGNED_CONTEXT((#{mm},#{rad},#{sr})) REPRESENTATION_CONTEXT('',''))"
        ));

        let vertices: Vec<usize> = body
            .vertices
            .iter()
            .map(|v| {
                let p = self.point(v.point);
                self.add(format!("VERTEX_POINT('',#{p})"))
            })
            .collect();
        let edges: Vec<usize> = body
            .edges
            .iter()
            .map(|e| {
                let c = self.curve(&e.curve);
                let (a, b) = (vertices[e.start], vertices[e.end]);
                self.add(format!("EDGE_CURVE('',#{a},#{b},#{c},.T.)"))
            })
            .collect();
        let shell = &body.shells[0];
        let faces: Vec<usize> = shell
            .faces
            .iter()
            .map(|&f| {
                let face = &body.faces[f];
                let s = self.surface(&face.surface);
                let bounds: Vec<String> = face
                    .loops
                    .iter()
                    .map(|l| {
                        let oriented: Vec<String> = l
                            .coedges
                            .iter()
                            .map(|c| {
                                let o = self.add(format!("ORIENTED_EDGE('',*,*,#{},{})", edges[c.edge], logical(!c.reversed)));
                                format!("#{o}")
                            })
                            .collect();
                        let lp = self.add(format!("EDGE_LOOP('',({}))", oriented.join(",")));
                        format!("#{}", self.add(format!("FACE_BOUND('',#{lp},.T.)")))
                    })
                    .collect();
                self.add(format!("ADVANCED_FACE('',({}),#{s},{})", bounds.join(","), logical(face.sense)))
            })
            .collect();
        let list: Vec<String> = faces.iter().map(|f| format!("#{f}")).collect();
        let cs = self.add(format!("CLOSED_SHELL('',({}))", list.join(",")));
        let brep = self.add(format!("MANIFOLD_SOLID_BREP('body',#{cs})"));
        let origin = self.placement(DVec3::ZERO, DVec3::Z, DVec3::X);
        let rep = self.add(format!("ADVANCED_BREP_SHAPE_REPRESENTATION('',(#{origin},#{brep}),#{ctx})"));
        self.add(format!("SHAPE_DEFINITION_REPRESENTATION(#{pds},#{rep})"));
        std::mem::take(&mut self.lines)
    }
}

fn logical(b: bool) -> &'static str {
    if b { ".T." } else { ".F." }
}

/// A Part 21 real: the shortest decimal that reads back as `x`, with a
/// decimal point and an upper-case exponent (`1e-5` is written `1.E-5`).
fn real(x: f64) -> String {
    let s = format!("{x:?}");
    match s.split_once('e') {
        Some((m, e)) => format!("{m}{}E{e}", if m.contains('.') { "" } else { "." }),
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures;
    use crate::geom::Transform;
    use crate::ops::primitives::{make_box, make_cylinder, make_sphere};
    use crate::ops::profile::{Boundary, Profile};
    use crate::topology::{Coedge, Loop};
    use glam::DVec2;
    use std::collections::HashMap;

    /// A file in `tests/step/` with its `/* … */` notes (the hand checking)
    /// taken out, and the lines left empty by them.
    fn hand_checked(name: &str) -> String {
        let text = std::fs::read_to_string(format!("{}/tests/step/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let mut out = String::new();
        let mut rest = text.as_str();
        while let Some(at) = rest.find("/*") {
            out.push_str(&rest[..at]);
            rest = &rest[at + rest[at..].find("*/").unwrap() + 2..];
        }
        out.push_str(rest);
        out.lines().filter(|l| !l.trim().is_empty()).map(|l| format!("{l}\n")).collect()
    }

    #[test]
    fn unit_cube_file_is_the_hand_checked_one() {
        // tests/step/unit_cube.step says why each line is what it is (worked
        // from the cube's geometry: which corners each edge joins, which
        // way each face's loop runs seen from outside); OpenCascade reads
        // the same file in prototypes/oracle/test_step_check.py.
        assert_eq!(write(&make_box(1.0, 1.0, 1.0).unwrap()).unwrap(), hand_checked("unit_cube.step"));
    }

    #[test]
    fn cylinder_and_sphere_files_are_the_hand_checked_ones() {
        assert_eq!(write(&make_cylinder(2.0, 3.0).unwrap()).unwrap(), hand_checked("cylinder_r2_h3.step"));
        assert_eq!(write(&make_sphere(2.0).unwrap()).unwrap(), hand_checked("sphere_r2.step"));
    }

    #[test]
    fn the_hand_checked_files_can_tell_a_change() {
        // The comparison above can fail: the same cube moved half a unit
        // along x has other x coordinates, so its file mustn't match.
        let moved = make_box(1.0, 1.0, 1.0).unwrap().transformed(&Transform::translation(DVec3::new(0.5, 0.0, 0.0)));
        assert_ne!(write(&moved).unwrap(), hand_checked("unit_cube.step"));
    }

    #[test]
    fn reals_are_written_as_part_21_wants() {
        // By hand: Part 21 needs a decimal point, and an upper-case E before
        // any exponent; Rust's shortest form gives the digits.
        for (x, s) in [
            (1.0, "1.0"),
            (0.0, "0.0"),
            (-0.0, "-0.0"),
            (0.1, "0.1"),
            (-2.5, "-2.5"),
            (1e-5, "1.E-5"),
            (1.5e-7, "1.5E-7"),
            (1e16, "1.E16"),
            (123456.789, "123456.789"),
            (-1.7976931348623157e308, "-1.7976931348623157E308"),
        ] {
            assert_eq!(real(x), s);
        }
    }

    #[test]
    fn every_real_reads_back_as_the_same_double() {
        // Seeded (xorshift64*), any bit pattern that is a finite double:
        // the decimal must parse back to exactly those bits.
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut seen = 0;
        while seen < 20_000 {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            let x = f64::from_bits(state.wrapping_mul(0x2545_f491_4f6c_dd1d));
            if !x.is_finite() {
                continue;
            }
            seen += 1;
            let s = real(x);
            assert!(s.contains('.') && !s.contains('e'), "{s}");
            assert_eq!(s.parse::<f64>().unwrap().to_bits(), x.to_bits(), "{x:e} written {s}");
        }
    }

    #[test]
    fn a_non_finite_number_is_noticed() {
        let mut w = Writer::default();
        w.real(1.0);
        assert!(!w.non_finite);
        w.real(f64::NAN);
        w.real(2.0);
        assert!(w.non_finite, "a later finite number mustn't clear it");
        let mut w = Writer::default();
        w.triple(DVec3::new(0.0, f64::INFINITY, 0.0));
        assert!(w.non_finite);
    }

    fn refused(body: &Body) -> String {
        match write(body) {
            Err(KernelError::InvalidInput { inputs, message }) => {
                assert!(inputs.is_empty());
                message
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn an_invalid_body_is_refused() {
        // A face turned over: its normal flipped and its loop walked the
        // other way, so its edges run the same way as their neighbours'.
        let mut b = fixtures::hand_cube();
        b.faces[0].sense = false;
        b.faces[0].loops[0].coedges.reverse();
        b.faces[0].loops[0].coedges.iter_mut().for_each(|c| c.reversed = !c.reversed);
        assert!(refused(&b).starts_with("only a valid body can be written to STEP: "));
        // Only the normal flipped.
        let mut b = fixtures::hand_cube();
        b.faces[2].sense = false;
        assert!(refused(&b).starts_with("only a valid body can be written to STEP: "));
        // An edge naming a vertex that isn't there: refused, not a panic.
        let mut b = fixtures::hand_cube();
        b.edges[3].end = 99;
        assert!(refused(&b).starts_with("only a valid body can be written to STEP: "));
        // A vertex at NaN.
        let mut b = fixtures::hand_cube();
        b.vertices[7].point.z = f64::NAN;
        assert!(refused(&b).starts_with("only a valid body can be written to STEP: "));
        // A coedge naming an edge that isn't there.
        let mut b = fixtures::hand_cube();
        b.faces[1].loops[0].coedges[0] = Coedge { edge: 1000, reversed: false };
        assert!(refused(&b).starts_with("only a valid body can be written to STEP: "));
    }

    #[test]
    fn a_body_of_two_shells_is_refused_with_words() {
        let a = fixtures::hand_cube();
        let b = a.transformed(&Transform::translation(DVec3::new(3.0, 0.0, 0.0)));
        let two = fixtures::two_shells(&a, &b);
        assert!(crate::validate::validate(&two).is_ok(), "the refusal must be the writer's own");
        assert_eq!(
            refused(&two),
            "a body of 2 shells can't be written to STEP yet (one shell only until booleans make voids)"
        );
        assert_eq!(refused(&Body::default()), "an empty body can't be written to STEP");
    }

    /// Bodies of every kind the kernel makes today, at sizes and places
    /// across the modelling range.
    fn bodies() -> Vec<(String, Body)> {
        let mut out: Vec<(String, Body)> = vec![
            ("hand cube".into(), fixtures::hand_cube()),
            ("hand cylinder".into(), fixtures::hand_cylinder(1.5, 4.0)),
            ("hand sphere".into(), fixtures::hand_sphere(3.0)),
            ("twisted cylinder".into(), fixtures::hand_twisted_cylinder(1.0, 2.0, 0.7)),
            ("half cylinder".into(), fixtures::hand_half_cylinder(2.0, 1.0)),
            ("tube".into(), fixtures::hand_tube(1.0, 2.0, 3.0, 0.4)),
            // (The sphere slice, cap and octant fixtures aren't valid bodies
            // yet: their sphere faces wait for the general tessellator, 38a.)
            ("tiny box".into(), make_box(1e-3, 2e-3, 3e-3).unwrap()),
            ("huge box".into(), make_box(1e6, 5e5, 1e3).unwrap()),
            ("cylinder".into(), make_cylinder(0.25, 7.0).unwrap()),
            ("sphere".into(), make_sphere(1234.5).unwrap()),
        ];
        let arc_slot = Profile {
            outer: Boundary::Path {
                corners: vec![DVec2::new(0.0, 0.0), DVec2::new(10.0, 0.0), DVec2::new(10.0, 4.0), DVec2::new(0.0, 4.0)],
                bulges: vec![0.0, 0.5, 0.0, -0.3],
            },
            holes: vec![
                Boundary::Circle { center: DVec2::new(5.0, 2.0), radius: 1.0 },
                Boundary::polygon(vec![DVec2::new(1.0, 1.0), DVec2::new(2.0, 1.0), DVec2::new(1.5, 3.0)]),
            ],
        };
        out.push(("arc slot".into(), crate::ops::extrude::extrude(&arc_slot, 2.5).unwrap()));
        let l_shape = Profile::polygon(
            vec![DVec2::new(0.0, 0.0), DVec2::new(40.0, 0.0), DVec2::new(40.0, 10.0), DVec2::new(10.0, 10.0), DVec2::new(10.0, 30.0), DVec2::new(0.0, 30.0)],
            vec![],
        );
        out.push(("L bracket".into(), crate::ops::extrude::extrude(&l_shape, 20.0).unwrap()));
        // Turned and moved far out, so coordinates are long decimals.
        let turn = Transform::rotation(DVec3::new(1.0, 2.0, 3.0).normalize(), 0.7);
        let far = Transform::translation(DVec3::new(9.0e7, -3.3e7, 1.0e5));
        for (name, b) in out.clone() {
            out.push((format!("{name} turned"), b.transformed(&turn)));
            out.push((format!("{name} turned far out"), b.transformed(&turn).transformed(&far)));
        }
        out
    }

    #[test]
    fn bodies_for_the_structure_checks_are_valid() {
        for (name, b) in bodies() {
            assert!(crate::validate::validate(&b).is_ok(), "{name}: {:?}", crate::validate::validate(&b));
        }
    }

    /// One argument of a Part 21 entity, as the tests read them back.
    #[derive(Debug, Clone, PartialEq)]
    enum Arg {
        Ref(usize),
        Real(f64),
        Int(i64),
        Text(String),
        Enum(String),
        List(Vec<Arg>),
        /// `*` or `$`.
        Omitted,
        /// A typed parameter such as `LENGTH_MEASURE(1.E-5)`.
        Typed(String, Vec<Arg>),
    }

    /// Reads `NAME(args)` or a list's items from `s` at `*at`.
    fn args(s: &[u8], at: &mut usize) -> Vec<Arg> {
        assert_eq!(s[*at], b'(');
        *at += 1;
        let mut out = vec![];
        loop {
            while s[*at] == b' ' {
                *at += 1;
            }
            if s[*at] == b')' {
                *at += 1;
                return out;
            }
            out.push(arg(s, at));
            while s[*at] == b' ' {
                *at += 1;
            }
            if s[*at] == b',' {
                *at += 1;
            }
        }
    }

    fn arg(s: &[u8], at: &mut usize) -> Arg {
        let start = *at;
        match s[*at] {
            b'#' => {
                *at += 1;
                while s[*at].is_ascii_digit() {
                    *at += 1;
                }
                Arg::Ref(std::str::from_utf8(&s[start + 1..*at]).unwrap().parse().unwrap())
            }
            b'\'' => {
                *at += 1;
                while s[*at] != b'\'' {
                    *at += 1;
                }
                *at += 1;
                Arg::Text(std::str::from_utf8(&s[start + 1..*at - 1]).unwrap().to_string())
            }
            b'.' => {
                *at += 1;
                while s[*at] != b'.' {
                    *at += 1;
                }
                *at += 1;
                Arg::Enum(std::str::from_utf8(&s[start..*at]).unwrap().to_string())
            }
            b'(' => Arg::List(args(s, at)),
            b'*' | b'$' => {
                *at += 1;
                Arg::Omitted
            }
            b'A'..=b'Z' => {
                while s[*at] != b'(' {
                    *at += 1;
                }
                let name = std::str::from_utf8(&s[start..*at]).unwrap().to_string();
                Arg::Typed(name, args(s, at))
            }
            _ => {
                while !matches!(s[*at], b',' | b')') {
                    *at += 1;
                }
                let text = std::str::from_utf8(&s[start..*at]).unwrap();
                if text.bytes().all(|c| c.is_ascii_digit() || c == b'-') {
                    return Arg::Int(text.parse().unwrap());
                }
                // Part 21's real: digits, a point, digits, maybe E and digits.
                let (mantissa, _) = text.split_once('E').unwrap_or((text, ""));
                assert!(mantissa.contains('.') && !text.contains('e'), "not a Part 21 real: {text}");
                Arg::Real(text.parse().unwrap())
            }
        }
    }

    /// The entities of a file this writer wrote: number k at index k − 1,
    /// as (type, arguments); "" for a complex entity `(A() B() …)`.
    fn entities(text: &str) -> Vec<(String, Vec<Arg>)> {
        let data = &text[text.find("DATA;\n").unwrap() + 6..text.find("ENDSEC;\nEND-ISO-10303-21;\n").unwrap()];
        data.lines()
            .enumerate()
            .map(|(k, line)| {
                let (number, rest) = line.split_once(" = ").unwrap();
                assert_eq!(number, format!("#{}", k + 1), "numbered in order");
                let body = rest.strip_suffix(';').unwrap().as_bytes();
                let mut at = 0;
                if body[0] == b'(' {
                    return (String::new(), args(body, &mut at));
                }
                let open = rest.find('(').unwrap();
                at = open;
                let a = args(body, &mut at);
                assert_eq!(at, body.len(), "{line}");
                (rest[..open].to_string(), a)
            })
            .collect()
    }

    fn refs(a: &Arg, out: &mut Vec<usize>) {
        match a {
            Arg::Ref(n) => out.push(*n),
            Arg::List(l) | Arg::Typed(_, l) => l.iter().for_each(|x| refs(x, out)),
            _ => {}
        }
    }

    /// Reads the body back out of a file, by the meaning each entity has in
    /// ISO 10303-42 (see the top of the file), into the kernel's own types.
    fn read_back(text: &str) -> Body {
        let e = entities(text);
        let get = |n: &Arg| -> &(String, Vec<Arg>) {
            match n {
                Arg::Ref(n) => &e[n - 1],
                _ => panic!("not a reference: {n:?}"),
            }
        };
        let real = |a: &Arg| match a {
            Arg::Real(x) => *x,
            _ => panic!("not a real: {a:?}"),
        };
        let triple = |a: &Arg, kind: &str| {
            let (name, args) = get(a);
            assert_eq!(name, kind);
            match &args[1] {
                Arg::List(l) if l.len() == 3 => DVec3::new(real(&l[0]), real(&l[1]), real(&l[2])),
                other => panic!("{other:?}"),
            }
        };
        let placement = |a: &Arg| {
            let (name, args) = get(a);
            assert_eq!(name, "AXIS2_PLACEMENT_3D");
            (triple(&args[1], "CARTESIAN_POINT"), triple(&args[2], "DIRECTION"), triple(&args[3], "DIRECTION"))
        };
        let logical = |a: &Arg| match a {
            Arg::Enum(s) if s == ".T." => true,
            Arg::Enum(s) if s == ".F." => false,
            _ => panic!("not a logical: {a:?}"),
        };
        let mut b = Body::default();
        let mut vertex_of = HashMap::new();
        let mut edge_of = HashMap::new();
        for (k, (name, args)) in e.iter().enumerate() {
            match name.as_str() {
                "VERTEX_POINT" => {
                    vertex_of.insert(k + 1, b.add_vertex(triple(&args[1], "CARTESIAN_POINT")));
                }
                "EDGE_CURVE" => {
                    let (curve, cargs) = get(&args[3]);
                    let curve = match curve.as_str() {
                        "LINE" => {
                            let (vector, vargs) = get(&cargs[2]);
                            assert_eq!((vector.as_str(), real(&vargs[2])), ("VECTOR", 1.0));
                            Curve::Line { origin: triple(&cargs[1], "CARTESIAN_POINT"), dir: triple(&vargs[1], "DIRECTION") }
                        }
                        "CIRCLE" => {
                            let (center, axis, x_dir) = placement(&cargs[1]);
                            Curve::Circle { center, axis, x_dir, radius: real(&cargs[2]) }
                        }
                        other => panic!("{other}"),
                    };
                    assert!(logical(&args[4]), "edges run with their curves");
                    let at = |a: &Arg| match a {
                        Arg::Ref(n) => vertex_of[n],
                        _ => panic!(),
                    };
                    // The parameters aren't in the file; the vertices bound it.
                    edge_of.insert(k + 1, b.add_edge(curve, at(&args[1]), at(&args[2]), 0.0, 0.0));
                }
                "ADVANCED_FACE" => {
                    let (surface, sargs) = get(&args[2]);
                    let surface = match surface.as_str() {
                        "PLANE" => {
                            let (origin, normal, x_dir) = placement(&sargs[1]);
                            Surface::Plane { origin, normal, x_dir }
                        }
                        "CYLINDRICAL_SURFACE" => {
                            let (origin, axis, x_dir) = placement(&sargs[1]);
                            Surface::Cylinder { origin, axis, x_dir, radius: real(&sargs[2]) }
                        }
                        "SPHERICAL_SURFACE" => {
                            let (center, axis, x_dir) = placement(&sargs[1]);
                            Surface::Sphere { center, axis, x_dir, radius: real(&sargs[2]) }
                        }
                        other => panic!("{other}"),
                    };
                    let Arg::List(bounds) = &args[1] else { panic!() };
                    let loops = bounds
                        .iter()
                        .map(|fb| {
                            let (fname, fargs) = get(fb);
                            assert_eq!(fname, "FACE_BOUND");
                            assert!(logical(&fargs[2]));
                            let (lname, largs) = get(&fargs[1]);
                            assert_eq!(lname, "EDGE_LOOP");
                            let Arg::List(oes) = &largs[1] else { panic!() };
                            let coedges = oes
                                .iter()
                                .map(|oe| {
                                    let (oname, oargs) = get(oe);
                                    assert_eq!((oname.as_str(), &oargs[1], &oargs[2]), ("ORIENTED_EDGE", &Arg::Omitted, &Arg::Omitted));
                                    let Arg::Ref(n) = &oargs[3] else { panic!() };
                                    Coedge { edge: edge_of[n], reversed: !logical(&oargs[4]) }
                                })
                                .collect();
                            Loop { coedges }
                        })
                        .collect();
                    b.add_face(surface, logical(&args[3]), loops);
                }
                _ => {}
            }
        }
        b.shells.push(crate::topology::Shell { faces: (0..b.faces.len()).collect() });
        b
    }

    #[test]
    fn every_body_reads_back_from_its_file_exactly() {
        // Self-consistency (a reader written to the same reading of the
        // standard), so it doesn't count as the hand-worked test; it checks
        // that nothing is lost, reordered or rounded: every coordinate to
        // the bit, every edge's ends, every loop's coedges and directions.
        for (name, body) in bodies() {
            let back = read_back(&write(&body).unwrap());
            assert_eq!(back.vertices, body.vertices, "{name}");
            assert_eq!(back.edges.len(), body.edges.len(), "{name}");
            for (a, b) in back.edges.iter().zip(&body.edges) {
                assert_eq!((&a.curve, a.start, a.end), (&b.curve, b.start, b.end), "{name}");
            }
            let shell = &body.shells[0];
            assert_eq!(back.faces.len(), shell.faces.len(), "{name}");
            for (a, &f) in back.faces.iter().zip(&shell.faces) {
                let b = &body.faces[f];
                assert_eq!((&a.surface, a.sense, &a.loops), (&b.surface, b.sense, &b.loops), "{name}");
            }
        }
    }

    #[test]
    fn every_entity_is_used_and_refers_only_backwards() {
        for (name, body) in bodies() {
            let text = write(&body).unwrap();
            let e = entities(&text);
            let mut used = vec![0; e.len() + 1];
            for (k, (_, args)) in e.iter().enumerate() {
                let mut r = vec![];
                args.iter().for_each(|a| refs(a, &mut r));
                for n in r {
                    assert!(n <= k, "{name}: #{} refers forward to #{n}", k + 1);
                    used[n] += 1;
                }
            }
            // Only the protocol definition (#2) and the last line, which
            // ties the shape to the product, are roots nothing refers to.
            let roots: Vec<usize> = (1..=e.len()).filter(|&n| used[n] == 0).collect();
            assert_eq!(roots, vec![2, e.len()], "{name}");
            let count = |kind: &str| e.iter().filter(|(n, _)| n == kind).count();
            let loops: usize = body.faces.iter().map(|f| f.loops.len()).sum();
            assert_eq!(count("VERTEX_POINT"), body.vertices.len(), "{name}");
            assert_eq!(count("EDGE_CURVE"), body.edges.len(), "{name}");
            assert_eq!(count("ORIENTED_EDGE"), 2 * body.edges.len(), "{name}: every edge used twice");
            assert_eq!((count("EDGE_LOOP"), count("FACE_BOUND")), (loops, loops), "{name}");
            assert_eq!(count("ADVANCED_FACE"), body.faces.len(), "{name}");
            assert_eq!((count("CLOSED_SHELL"), count("MANIFOLD_SOLID_BREP")), (1, 1), "{name}");
            assert_eq!(write(&body).unwrap(), text, "{name}: the same body gives the same file");
        }
    }
}
