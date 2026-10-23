// The oracle's STEP files, shared by its writers: tests/stateful.rs (29b2)
// and tests/fuzz_corpus.rs (29b3). Tested in stateful.rs
// (the_oracle_is_given_each_body_as_a_step_file_of_where_it_is and
// the_planted_step_fault_flips_one_face_and_nothing_else).

use fission_kernel::step_write;
use fission_kernel::topology::Body;

/// The oracle's "step" and "step_refused": the body's STEP file (with the
/// planted fault when FISSION_STEP_FAULT is set), or why the writer refused
/// it.
pub fn step_file(world: &Body) -> (Option<String>, Option<String>) {
    match step_write::write(world) {
        Ok(text) if std::env::var_os("FISSION_STEP_FAULT").is_some() => (Some(flip_first_face(&text)), None),
        Ok(text) => (Some(text), None),
        Err(e) => (None, Some(e.to_string())),
    }
}

/// `text` with its first face's normal flipped (`ADVANCED_FACE`'s
/// same_sense swapped) and nothing else changed: the planted fault
/// FISSION_STEP_FAULT gives the oracle, which OpenCascade's checker must
/// catch (prototypes/oracle/test_step_check.py plants the same one by hand).
pub fn flip_first_face(text: &str) -> String {
    let mut done = false;
    let lines: Vec<String> = text
        .lines()
        .map(|l| {
            if done || !l.contains("= ADVANCED_FACE(") {
                return l.to_string();
            }
            done = true;
            if let Some(head) = l.strip_suffix(",.T.);") {
                format!("{head},.F.);")
            } else if let Some(head) = l.strip_suffix(",.F.);") {
                format!("{head},.T.);")
            } else {
                panic!("an ADVANCED_FACE line the writer doesn't write: {l}")
            }
        })
        .collect();
    assert!(done, "no face to flip");
    lines.join("\n") + if text.ends_with('\n') { "\n" } else { "" }
}
