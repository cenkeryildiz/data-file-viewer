//! Test-only q file encoder: builds the byte layout of `` `:f set table`` by hand (no q licence needed).
#![allow(dead_code)]

pub fn vector(t: u8, n: usize, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![t, 0];
    v.extend((n as i32).to_le_bytes());
    v.extend(payload);
    v
}
pub fn sym_vec(names: &[&str]) -> Vec<u8> {
    let mut p = Vec::new();
    for n in names {
        p.extend(n.as_bytes());
        p.push(0);
    }
    vector(11, names.len(), &p)
}
pub fn table_with(names: Vec<u8>, n_cols: i32, cols: &[Vec<u8>]) -> Vec<u8> {
    let mut f = vec![0xff, 0x01, 98, 0, 99];
    f.extend(names);
    f.extend([0, 0]);
    f.extend(n_cols.to_le_bytes());
    for c in cols {
        f.extend(c);
    }
    f
}
pub fn table(names: &[&str], cols: &[Vec<u8>]) -> Vec<u8> {
    table_with(sym_vec(names), cols.len() as i32, cols)
}
pub fn i16s(t: u8, v: &[i16]) -> Vec<u8> {
    vector(
        t,
        v.len(),
        &v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<_>>(),
    )
}
pub fn i32s(t: u8, v: &[i32]) -> Vec<u8> {
    vector(
        t,
        v.len(),
        &v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<_>>(),
    )
}
pub fn i64s(t: u8, v: &[i64]) -> Vec<u8> {
    vector(
        t,
        v.len(),
        &v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<_>>(),
    )
}
pub fn f32s(v: &[f32]) -> Vec<u8> {
    vector(
        8,
        v.len(),
        &v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<_>>(),
    )
}
pub fn f64s(t: u8, v: &[f64]) -> Vec<u8> {
    vector(
        t,
        v.len(),
        &v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<_>>(),
    )
}
pub fn bytes(t: u8, v: &[u8]) -> Vec<u8> {
    vector(t, v.len(), v)
}
pub fn guids(v: &[[u8; 16]]) -> Vec<u8> {
    vector(2, v.len(), &v.concat())
}
pub fn syms(v: &[&str]) -> Vec<u8> {
    sym_vec(v)
}
/// General list whose elements are already-encoded objects.
pub fn general(items: &[Vec<u8>]) -> Vec<u8> {
    vector(0, items.len(), &items.concat())
}
pub fn atom(t: i8, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![t as u8];
    v.extend(payload);
    v
}

/// xorshift64* so the fuzz and oracle fixtures are deterministic.
pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
}
