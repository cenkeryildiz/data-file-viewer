//! Bounded Compact Thrift preflight: sizes/counts are checked before parquet allocates.
use crate::{Error, Limits, bad};

#[derive(Default)]
pub struct Page {
    pub kind: Option<i64>,
    pub compressed: Option<i64>,
    pub decoded: Option<i64>,
    pub values: Option<i64>,
    pub level_bytes: usize,
    pub values_compressed: bool,
}
struct Compact<'a> {
    bytes: &'a [u8],
    at: usize,
    items: usize,
    cap: usize,
    page: Page,
    footer: bool,
    children: Vec<usize>,
    limits: &'a Limits,
}
impl<'a> Compact<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self
            .at
            .checked_add(n)
            .ok_or_else(|| bad("Thrift length overflow"))?;
        let b = self
            .bytes
            .get(self.at..end)
            .ok_or_else(|| bad("Truncated Thrift value"))?;
        self.at = end;
        Ok(b)
    }
    fn byte(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }
    fn varint(&mut self) -> Result<u64, Error> {
        let mut n = 0u64;
        for shift in (0..70).step_by(7) {
            let b = self.byte()?;
            if shift == 63 && b > 1 {
                return Err(bad("Thrift integer overflow"));
            }
            n |= u64::from(b & 127) << shift;
            if b & 128 == 0 {
                return Ok(n);
            }
        }
        Err(bad("Invalid Thrift integer"))
    }
    fn integer(&mut self) -> Result<i64, Error> {
        let n = self.varint()?;
        Ok((n >> 1) as i64 ^ -((n & 1) as i64))
    }
    fn count(&mut self, n: usize) -> Result<(), Error> {
        self.items = self
            .items
            .checked_add(n)
            .ok_or_else(|| bad("Thrift count overflow"))?;
        if self.items > self.cap {
            return Err(Error::TooLarge("Thrift item budget exceeded".into()));
        }
        Ok(())
    }
    fn value(&mut self, t: u8, path: &mut Vec<i16>, container: bool) -> Result<(), Error> {
        self.count(1)?;
        if path.len() > 32 {
            return Err(Error::TooLarge("Thrift nesting exceeds 32".into()));
        }
        match t {
            1 | 2 => {
                let yes = if container {
                    match self.byte()? {
                        1 => true,
                        2 => false,
                        _ => return Err(bad("Invalid Thrift boolean")),
                    }
                } else {
                    t == 1
                };
                if !self.footer && path.as_slice() == [8, 7] {
                    self.page.values_compressed = yes;
                }
            }
            3 => {
                self.take(1)?;
            }
            4..=6 => {
                let n = self.integer()?;
                if self.footer {
                    if path.as_slice() == [2, 0, 5] {
                        let n = usize::try_from(n).map_err(|_| bad("Negative schema children"))?;
                        if n > self.limits.schema_nodes {
                            return Err(Error::TooLarge("Schema children budget".into()));
                        }
                        *self
                            .children
                            .last_mut()
                            .ok_or_else(|| bad("Missing schema element"))? = n;
                    }
                    if matches!(path.as_slice(), [4, 0, 1, 0, 3, 5] | [4, 0, 3])
                        && (n < 0 || n as u64 > self.limits.values)
                    {
                        return Err(Error::TooLarge("Row/value count budget".into()));
                    }
                } else {
                    match path.as_slice() {
                        [1] => self.page.kind = Some(n),
                        [2] => self.page.decoded = Some(n),
                        [3] => self.page.compressed = Some(n),
                        [5 | 7 | 8, 1] => self.page.values = Some(n),
                        [8, 2 | 3] if n < 0 || n as u64 > self.limits.values => {
                            return Err(Error::TooLarge("V2 page row/null count budget".into()));
                        }
                        [8, 5 | 6] => {
                            let n = usize::try_from(n).map_err(|_| bad("Negative level length"))?;
                            self.page.level_bytes = self
                                .page
                                .level_bytes
                                .checked_add(n)
                                .ok_or_else(|| bad("Level length overflow"))?;
                        }
                        _ => {}
                    }
                }
            }
            7 => {
                self.take(8)?;
            }
            8 => {
                let n = usize::try_from(self.varint()?)
                    .map_err(|_| bad("Thrift binary length overflow"))?;
                self.take(n)?;
            }
            9 | 10 => {
                let h = self.byte()?;
                let n = if h >> 4 == 15 {
                    usize::try_from(self.varint()?).map_err(|_| bad("Thrift list overflow"))?
                } else {
                    usize::from(h >> 4)
                };
                self.count(n)?;
                if self.footer {
                    let cap = match path.as_slice() {
                        [2] => self.limits.schema_nodes,
                        [4] => self.limits.row_groups,
                        [7] | [4, 0, 1] => self.limits.columns,
                        _ => self.cap,
                    };
                    if n > cap {
                        return Err(Error::TooLarge("Metadata list budget".into()));
                    }
                }
                for _ in 0..n {
                    path.push(0);
                    self.value(h & 15, path, true)?;
                    path.pop();
                }
            }
            11 => {
                let n = usize::try_from(self.varint()?).map_err(|_| bad("Thrift map overflow"))?;
                self.count(n)?;
                if n > 0 {
                    let t = self.byte()?;
                    for _ in 0..n {
                        path.push(0);
                        self.value(t >> 4, path, true)?;
                        self.value(t & 15, path, true)?;
                        path.pop();
                    }
                }
            }
            12 => self.structure(path)?,
            _ => return Err(bad("Unknown Thrift type")),
        }
        Ok(())
    }
    fn structure(&mut self, path: &mut Vec<i16>) -> Result<(), Error> {
        if self.footer && path.as_slice() == [2, 0] {
            self.children.push(0);
        }
        let mut last = 0i16;
        loop {
            let h = self.byte()?;
            if h == 0 {
                return Ok(());
            }
            let id = if h >> 4 == 0 {
                i16::try_from(self.integer()?).map_err(|_| bad("Thrift field overflow"))?
            } else {
                last.checked_add(i16::from(h >> 4))
                    .ok_or_else(|| bad("Thrift field overflow"))?
            };
            last = id;
            if self.footer {
                let supported = match path.as_slice() {
                    [] => (1..=7).contains(&id),
                    [2, 0] => (1..=10).contains(&id),
                    [4, 0] => (1..=7).contains(&id),
                    [4, 0, 1, 0] => (1..=7).contains(&id),
                    [4, 0, 1, 0, 3] => (1..=16).contains(&id) && id != 8,
                    _ => true,
                };
                if !supported {
                    return Err(Error::Unsupported(format!(
                        "Parquet metadata field {path:?}/{id} has no preserving reconstruction policy"
                    )));
                }
            } else if path.is_empty() && (id == 4 || !(1..=8).contains(&id)) {
                return Err(Error::Unsupported(
                    "Page checksums or unknown page metadata cannot be preserved".into(),
                ));
            }
            path.push(id);
            self.value(h & 15, path, false)?;
            path.pop();
        }
    }
}
pub fn check(bytes: &[u8], limits: &Limits, footer: bool) -> Result<(usize, Page), Error> {
    let mut p = Compact {
        bytes,
        at: 0,
        items: 0,
        cap: limits.metadata_items,
        page: Page {
            values_compressed: true,
            ..Page::default()
        },
        footer,
        children: Vec::new(),
        limits,
    };
    p.structure(&mut Vec::new())?;
    if footer {
        let mut stack = vec![1usize];
        for n in p.children {
            while stack.last() == Some(&0) {
                stack.pop();
            }
            let remaining = stack
                .last_mut()
                .ok_or_else(|| bad("Extra schema element"))?;
            *remaining -= 1;
            if n > 0 {
                stack.push(n);
            }
            if stack.len() > 32 {
                return Err(Error::TooLarge("Parquet schema nesting exceeds 32".into()));
            }
        }
        if stack.iter().any(|n| *n != 0) {
            return Err(bad("Incomplete Parquet schema"));
        }
    }
    Ok((p.at, p.page))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_truncation_and_overflow_are_refused_before_allocation() {
        let limits = Limits::default();
        // root row_groups list claims u32::MAX elements without supplying any.
        assert!(matches!(
            check(&[0x49, 0xfc, 0xff, 0xff, 0xff, 0xff, 0x0f], &limits, true),
            Err(Error::TooLarge(_))
        ));
        assert!(
            check(
                &[
                    0x18, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02
                ],
                &limits,
                false
            )
            .is_err()
        );
        assert!(check(&[0x15], &limits, false).is_err());
        assert!(check(&[0x4c, 0], &limits, false).is_err()); // checksum unsupported before parsing body
    }
    #[test]
    fn schema_child_count_is_bounded() {
        // schema list, one SchemaElement with num_children=32767.
        let b = [0x29, 0x1c, 0x55, 0xfe, 0xff, 0x03, 0, 0];
        assert!(matches!(
            check(&b, &Limits::default(), true),
            Err(Error::TooLarge(_))
        ));
    }
}
