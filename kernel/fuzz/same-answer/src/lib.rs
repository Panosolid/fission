//! The answers of `../answers.rs`, for a native program (`main.rs`) and,
//! with no wasm-bindgen glue, for WebAssembly: Node writes an input into
//! memory from `answer_input`, calls `answer`, and reads the line back.
#[path = "../../checks.rs"]
#[allow(dead_code)]
pub mod checks;
#[path = "../../answers.rs"]
pub mod answers;

pub const TARGETS: [&str; 3] = ["extrude", "sketch", "placed"];

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::cell::RefCell;

    thread_local! {
        static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
        static OUTPUT: RefCell<String> = const { RefCell::new(String::new()) };
    }

    /// Room for an input of `len` bytes; returns where to write it.
    #[no_mangle]
    pub extern "C" fn answer_input(len: usize) -> *mut u8 {
        INPUT.with(|i| {
            let mut i = i.borrow_mut();
            i.clear();
            i.resize(len, 0);
            i.as_mut_ptr()
        })
    }

    /// The answer for the input written last, for target `TARGETS[t]`;
    /// returns where the line starts, and `answer_len` its length.
    #[no_mangle]
    pub extern "C" fn answer(t: usize) -> *const u8 {
        let line = INPUT.with(|i| super::answers::answer(super::TARGETS[t], &i.borrow()));
        OUTPUT.with(|o| {
            *o.borrow_mut() = line;
            o.borrow().as_ptr()
        })
    }

    #[no_mangle]
    pub extern "C" fn answer_len() -> usize {
        OUTPUT.with(|o| o.borrow().len())
    }
}
