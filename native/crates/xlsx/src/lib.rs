//! D3.8 spreadsheet reads for the native table worker (standalone crate; not wired to a worker).
pub mod budget;
pub mod sheet_tables;
pub mod xlsx_read;

use sheet_tables::{Cell, DetectOptions, SheetTable, detect_tables};
use xlsx_read::Sheet;

/// The tables on one sheet, detected over the text grid an `all_varchar` read would hand over.
pub fn detect_sheet_tables(
    sheet: &Sheet,
    max_cells: u64,
    opts: &DetectOptions,
) -> Result<Vec<SheetTable>, budget::Refusal> {
    let grid: Vec<Vec<Cell>> = sheet
        .text_grid(max_cells)?
        .into_iter()
        .map(|row| row.into_iter().map(Cell::from).collect())
        .collect();
    Ok(detect_tables(&grid, opts))
}
