//! Validate variable-sized sections before the codec resizes buffers from their length fields.
use crate::{Error, Limits, bad, bound};
use dta::stata::dta::{byte_order::ByteOrder, header::Header, release::Release};
use std::collections::HashSet;

struct Slice<'a> {
    bytes: &'a [u8],
    order: ByteOrder,
}
impl<'a> Slice<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let (head, rest) = self
            .bytes
            .split_at_checked(n)
            .ok_or_else(|| bad("Truncated DTA section."))?;
        self.bytes = rest;
        Ok(head)
    }
    fn tag(&mut self, tag: &[u8]) -> Result<(), Error> {
        if self.take(tag.len())? != tag {
            return Err(bad("Invalid DTA section tag."));
        }
        Ok(())
    }
    fn number(&mut self, n: usize) -> Result<u64, Error> {
        let order = self.order;
        let b = self.take(n)?;
        Ok(match order {
            ByteOrder::LittleEndian => b.iter().rev().fold(0u64, |v, b| (v << 8) | u64::from(*b)),
            ByteOrder::BigEndian => b.iter().fold(0u64, |v, b| (v << 8) | u64::from(*b)),
        })
    }
    fn end(&self) -> Result<(), Error> {
        if self.bytes.is_empty() {
            Ok(())
        } else {
            Err(bad("Unexpected bytes after a DTA section."))
        }
    }
}
fn map(bytes: &[u8], start: usize, h: &Header) -> Result<[usize; 14], Error> {
    let mut s = Slice {
        bytes: bytes
            .get(start..)
            .ok_or_else(|| bad("Invalid DTA map offset."))?,
        order: h.byte_order(),
    };
    s.tag(b"<map>")?;
    let mut offsets = [0usize; 14];
    for p in &mut offsets {
        *p = usize::try_from(s.number(8)?).map_err(|_| bad("DTA offset overflow."))?;
    }
    s.tag(b"</map>")?;
    if offsets[0] != 0
        || offsets[1] != start
        || offsets[13] != bytes.len()
        || offsets[2] != start + 5 + 14 * 8 + 6
        || offsets.windows(2).any(|w| w[0] >= w[1])
    {
        return Err(bad("Invalid DTA section map."));
    }
    let tags: [&[u8]; 11] = [
        b"<variable_types>",
        b"<varnames>",
        b"<sortlist>",
        b"<formats>",
        b"<value_label_names>",
        b"<variable_labels>",
        b"<characteristics>",
        b"<data>",
        b"<strls>",
        b"<value_labels>",
        b"</stata_dta>",
    ];
    for (offset, tag) in offsets[2..13].iter().zip(tags) {
        if !bytes.get(*offset..).is_some_and(|s| s.starts_with(tag)) {
            return Err(bad("DTA section map disagrees with its tags."));
        }
    }
    if &bytes[offsets[12]..] != b"</stata_dta>" {
        return Err(bad("Truncated or trailing DTA bytes."));
    }
    Ok(offsets)
}
pub fn check(bytes: &[u8], start: usize, h: &Header, l: &Limits) -> Result<(), Error> {
    let m = map(bytes, start, h)?;
    let data_len = m[10] - m[9];
    bound(bytes.len() - data_len, l.metadata_bytes, "DTA metadata")?;
    let mut s = Slice {
        bytes: &bytes[m[10]..m[11]],
        order: h.byte_order(),
    };
    s.tag(b"<strls>")?;
    let mut keys = HashSet::new();
    while !s.bytes.starts_with(b"</strls>") {
        s.tag(b"GSO")?;
        let variable = s.number(4)?;
        let observation = s.number(if h.release() == Release::V117 { 4 } else { 8 })?;
        if variable == 0
            || variable > u64::from(h.variable_count())
            || observation == 0
            || observation > h.observation_count()
            || !keys.insert((variable, observation))
        {
            return Err(bad("Invalid or duplicate DTA long-string key."));
        }
        bound(keys.len(), l.metadata_entries, "DTA long strings")?;
        let kind = s.number(1)?;
        if !matches!(kind, 129 | 130) {
            return Err(bad("Invalid DTA long-string kind."));
        }
        let n = s.number(4)? as usize;
        bound(n, l.cell_bytes, "DTA long-string bytes")?;
        let payload = s.take(n)?;
        if kind == 130 && payload.last() != Some(&0) {
            return Err(bad("Unterminated DTA long string."));
        }
    }
    s.tag(b"</strls>")?;
    s.end()?;

    let mut s = Slice {
        bytes: &bytes[m[11]..m[12]],
        order: h.byte_order(),
    };
    s.tag(b"<value_labels>")?;
    let mut entries = 0usize;
    let mut sets = 0usize;
    while !s.bytes.starts_with(b"</value_labels>") {
        s.tag(b"<lbl>")?;
        let n = s.number(4)? as usize;
        bound(n, l.metadata_bytes, "DTA label table")?;
        s.take(if h.release() == Release::V117 {
            33 + 3
        } else {
            129 + 3
        })?;
        let mut payload = Slice {
            bytes: s.take(n)?,
            order: h.byte_order(),
        };
        let count = payload.number(4)? as usize;
        let text_len = payload.number(4)? as usize;
        entries = entries.saturating_add(count);
        sets += 1;
        bound(entries, l.metadata_entries, "DTA value labels")?;
        bound(sets, l.metadata_entries, "DTA value-label sets")?;
        payload.take(
            count
                .checked_mul(8)
                .ok_or_else(|| bad("DTA label count overflow."))?,
        )?;
        payload.take(text_len)?;
        payload.end()?;
        s.tag(b"</lbl>")?;
    }
    s.tag(b"</value_labels>")?;
    s.end()
}
pub fn check_data(bytes: &[u8], start: usize, h: &Header, row: usize) -> Result<(), Error> {
    let m = map(bytes, start, h)?;
    let n = h
        .observation_count()
        .checked_mul(row as u64)
        .and_then(|n| n.checked_add(13))
        .ok_or_else(|| bad("DTA data size overflow."))?;
    if n != (m[10] - m[9]) as u64 || &bytes[m[10] - 7..m[10]] != b"</data>" {
        return Err(bad(
            "DTA row count or width disagrees with its data section.",
        ));
    }
    Ok(())
}
