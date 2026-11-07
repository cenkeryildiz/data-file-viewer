//! D3.16: patch one cell of an .xlsx package, leaving every other member's bytes alone.
//! Ports `src/zipPatch.ts` (index/read/rewrite) and `src/xlsxWrite.ts` (planPatch, verifyCandidate).
//! Produces bytes only; reading the file, locking and publishing belong to D3.12.
pub mod xlsx_patch;
pub mod zip;

pub use xlsx_patch::{
    CellValue, PatchError, PatchPlan, PatchRequest, Patched, patch_cell, plan_patch,
    verify_candidate,
};
