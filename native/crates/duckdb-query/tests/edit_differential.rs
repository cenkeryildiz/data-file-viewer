//! D3.6: the edit gate (`edit::base_table_of_select`) against the reference `baseTableOfSelect` on the corpus in
//! tests/fixtures/edit_select_differential.json (tools/make_edit_differential.cjs).
use dfv_table_duckdb::edit::base_table_of_select;
use serde_json::Value as J;
use std::path::Path;

#[test]
fn the_edit_gate_names_the_same_table_as_the_reference_for_every_sql() {
    let file =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/edit_select_differential.json");
    let corpus: J = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 130);
    let wrong: Vec<String> = cases
        .iter()
        .filter_map(|c| {
            let sql = c["sql"].as_str().unwrap();
            let want = c["table"].as_str();
            let got = base_table_of_select(sql);
            (got.as_deref() != want)
                .then(|| format!("{sql:?}: reference {want:?} / native {got:?}"))
        })
        .collect();
    assert!(
        wrong.is_empty(),
        "{} of {} differ:\n{}",
        wrong.len(),
        cases.len(),
        wrong.join("\n")
    );
}
