//! Prints the native build's answer line for every saved fuzz input:
//! `<target>\t<input name>\t<answer>`, in the order `inputs.mjs` lists them.
//!
//!   same-answer <kernel dir>
use fission_same_answer::{answers, TARGETS};
use std::io::Write;
use std::path::Path;

fn main() {
    let root = std::env::args().nth(1).expect("usage: same-answer <kernel dir>");
    let root = Path::new(&root);
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for target in TARGETS {
        let packed = std::fs::read(root.join("fuzz/seeds").join(format!("{target}.seeds"))).expect("seeds file");
        let mut inputs: Vec<(String, Vec<u8>)> = vec![];
        let mut at = 0;
        while at < packed.len() {
            let size = u32::from_le_bytes(packed[at..at + 4].try_into().unwrap()) as usize;
            inputs.push((format!("seed {}", inputs.len()), packed[at + 4..at + 4 + size].to_vec()));
            at += 4 + size;
        }
        if let Ok(entries) = std::fs::read_dir(root.join("tests/regressions/libfuzzer").join(target)) {
            let mut files: Vec<_> = entries.map(|e| e.unwrap().path()).filter(|p| p.is_file()).collect();
            files.sort_by_key(|f| f.file_name().unwrap().to_owned());
            for f in files {
                inputs.push((f.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(&f).unwrap()));
            }
        }
        for (name, data) in inputs {
            writeln!(out, "{target}\t{name}\t{}", answers::answer(target, &data)).unwrap();
        }
    }
}
