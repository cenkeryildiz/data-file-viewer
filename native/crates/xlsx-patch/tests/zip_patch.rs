//! Ports of test/zipPatch.test.ts plus hostile-archive cases, on archives built by a tiny in-test writer.
use dfv_table_xlsx_patch::zip::{index_zip, read_member, rewrite_zip};
use flate2::{Compression, write::DeflateEncoder};
use std::collections::HashMap;
use std::io::Write;

struct Member<'a> {
    name: &'a str,
    data: &'a [u8],
    stored: bool,
    descriptor: bool,
}
fn m<'a>(name: &'a str, data: &'a [u8]) -> Member<'a> {
    Member {
        name,
        data,
        stored: false,
        descriptor: false,
    }
}

fn build(members: &[Member<'_>], comment: &[u8]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for mb in members {
        let (method, body) = if mb.stored {
            (0u16, mb.data.to_vec())
        } else {
            let mut e = DeflateEncoder::new(Vec::new(), Compression::new(6));
            e.write_all(mb.data).unwrap();
            (8, e.finish().unwrap())
        };
        let crc = crc32fast::hash(mb.data);
        let flags: u16 = if mb.descriptor { 8 } else { 0 };
        let offset = out.len() as u32;
        let (lc, ls) = if mb.descriptor {
            (0, 0)
        } else {
            (body.len() as u32, mb.data.len() as u32)
        };
        let lcrc = if mb.descriptor { 0 } else { crc };
        out.extend([0x50, 0x4b, 3, 4, 20, 0]);
        out.extend(flags.to_le_bytes());
        out.extend(method.to_le_bytes());
        out.extend([0x21, 0x00, 0x21, 0x58]); // time, date
        out.extend(lcrc.to_le_bytes());
        out.extend(lc.to_le_bytes());
        out.extend(ls.to_le_bytes());
        out.extend((mb.name.len() as u16).to_le_bytes());
        out.extend([0, 0]);
        out.extend(mb.name.as_bytes());
        out.extend(&body);
        if mb.descriptor {
            out.extend([0x50, 0x4b, 7, 8]);
            out.extend(crc.to_le_bytes());
            out.extend((body.len() as u32).to_le_bytes());
            out.extend((mb.data.len() as u32).to_le_bytes());
        }
        central.extend([0x50, 0x4b, 1, 2, 20, 0, 20, 0]);
        central.extend(flags.to_le_bytes());
        central.extend(method.to_le_bytes());
        central.extend([0x21, 0x00, 0x21, 0x58]);
        central.extend(crc.to_le_bytes());
        central.extend((body.len() as u32).to_le_bytes());
        central.extend((mb.data.len() as u32).to_le_bytes());
        central.extend((mb.name.len() as u16).to_le_bytes());
        central.extend([0u8; 12]); // extra, comment, disk, attrs
        central.extend(offset.to_le_bytes());
        central.extend(mb.name.as_bytes());
    }
    let cd_offset = out.len() as u32;
    out.extend(&central);
    out.extend([0x50, 0x4b, 5, 6, 0, 0, 0, 0]);
    out.extend((members.len() as u16).to_le_bytes());
    out.extend((members.len() as u16).to_le_bytes());
    out.extend((central.len() as u32).to_le_bytes());
    out.extend(cd_offset.to_le_bytes());
    out.extend((comment.len() as u16).to_le_bytes());
    out.extend(comment);
    out
}

fn members_of(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let idx = index_zip(bytes).expect("in scope");
    idx.entries
        .iter()
        .map(|e| (e.name.clone(), read_member(&idx, &e.name).unwrap().unwrap()))
        .collect()
}

fn sample() -> Vec<u8> {
    let big = format!("<a>{}</a>", "x".repeat(5000));
    build(
        &[
            m("a.xml", big.as_bytes()),
            m("dir/b.xml", b"<b/>"),
            Member {
                name: "stored.bin",
                data: &[1, 2, 3, 4],
                stored: true,
                descriptor: false,
            },
            m("ünïcode.xml", "<u>é</u>".as_bytes()),
        ],
        b"cmt",
    )
}

#[test]
fn rewrite_keeps_every_member_and_a_replacement_changes_only_that_member() {
    let original = sample();
    let idx = index_zip(&original).unwrap();
    let same = rewrite_zip(&idx, &HashMap::new()).unwrap();
    assert_eq!(members_of(&same), members_of(&original));
    let changed = rewrite_zip(
        &idx,
        &HashMap::from([("dir/b.xml".to_owned(), b"<b>new</b>".to_vec())]),
    )
    .unwrap();
    let (before, after) = (members_of(&original), members_of(&changed));
    assert_eq!(
        after.iter().map(|x| &x.0).collect::<Vec<_>>(),
        before.iter().map(|x| &x.0).collect::<Vec<_>>(),
        "order kept"
    );
    for ((n, d), (_, o)) in after.iter().zip(&before) {
        if n == "dir/b.xml" {
            assert_eq!(d, b"<b>new</b>")
        } else {
            assert_eq!(d, o, "{n}")
        }
    }
    let (ia, ib) = (index_zip(&changed).unwrap(), idx);
    assert_eq!(ia.comment, ib.comment, "archive comment kept");
}

#[test]
fn data_descriptor_archives_are_rewritten_correctly() {
    let original = build(
        &[
            Member {
                name: "one.xml",
                data: b"<one>1</one>",
                stored: false,
                descriptor: true,
            },
            Member {
                name: "two.xml",
                data: b"<two>2</two>",
                stored: true,
                descriptor: true,
            },
        ],
        b"",
    );
    let idx = index_zip(&original).expect("streamed archive is in scope");
    let out = rewrite_zip(
        &idx,
        &HashMap::from([("one.xml".to_owned(), b"<one>changed</one>".to_vec())]),
    )
    .unwrap();
    let got = members_of(&out);
    assert_eq!(got[0].1, b"<one>changed</one>");
    assert_eq!(got[1].1, b"<two>2</two>");
    assert_eq!(
        index_zip(&out)
            .unwrap()
            .entries
            .iter()
            .filter(|e| e.flags & 8 != 0)
            .count(),
        0,
        "descriptors dropped"
    );
}

#[test]
fn out_of_scope_archives_are_declined() {
    let ok = build(&[m("a.txt", b"a")], b"");
    let central = ok.windows(4).position(|w| w == [0x50, 0x4b, 1, 2]).unwrap();
    let mut encrypted = ok.clone();
    encrypted[central + 8] |= 1;
    assert!(index_zip(&encrypted).is_none());
    let mut multi = ok.clone();
    let n = multi.len();
    multi[n - 22 + 4] = 1;
    assert!(index_zip(&multi).is_none());
    assert!(index_zip(b"not a zip at all").is_none());
    assert!(index_zip(&ok[..ok.len() - 5]).is_none(), "truncated");
    assert!(index_zip(b"").is_none());
    let mut bad_method = ok.clone();
    bad_method[central + 10] = 9;
    assert!(
        index_zip(&bad_method).is_none(),
        "method other than stored/deflate"
    );
}

#[test]
fn duplicate_names_and_name_mismatch_are_declined() {
    assert!(index_zip(&build(&[m("a", b"1"), m("a", b"2")], b"")).is_none());
    let mut ok = build(&[m("a.txt", b"a")], b"");
    ok[30] = b'b'; // local name differs from the central record
    assert!(index_zip(&ok).is_none());
}

#[test]
fn local_zip64_headers_are_declined_even_when_central_sizes_fit() {
    let ordinary = build(&[m("sheet.xml", b"<sheet/>")], b"");
    let central = ordinary
        .windows(4)
        .position(|w| w == [0x50, 0x4b, 1, 2])
        .unwrap();
    let data_offset = 30 + u16::from_le_bytes([ordinary[26], ordinary[27]]) as usize;
    let mut extra = vec![1, 0, 16, 0];
    extra.extend(u64::from(u32::from_le_bytes(ordinary[22..26].try_into().unwrap())).to_le_bytes());
    extra.extend(u64::from(u32::from_le_bytes(ordinary[18..22].try_into().unwrap())).to_le_bytes());
    let mut a = [
        &ordinary[..data_offset],
        &extra[..],
        &ordinary[data_offset..],
    ]
    .concat();
    a[4] = 45;
    a[28..30].copy_from_slice(&20u16.to_le_bytes());
    a[18..22].copy_from_slice(&u32::MAX.to_le_bytes());
    a[22..26].copy_from_slice(&u32::MAX.to_le_bytes());
    let n = a.len();
    a[n - 6..n - 2].copy_from_slice(&((central + 20) as u32).to_le_bytes());
    assert!(
        index_zip(&a).is_none(),
        "rewriting must not retain stale ZIP64 local sizes"
    );
}

#[test]
fn a_lying_declared_size_is_an_error_not_an_allocation() {
    let mut zip = build(&[m("a.xml", &vec![b'x'; 100_000])], b"");
    // Local and central records both claim 10 bytes; the stream really inflates to 100 000.
    let central = zip
        .windows(4)
        .position(|w| w == [0x50, 0x4b, 1, 2])
        .unwrap();
    zip[22..26].copy_from_slice(&10u32.to_le_bytes());
    zip[central + 24..central + 28].copy_from_slice(&10u32.to_le_bytes());
    let idx = index_zip(&zip).expect("headers agree with each other");
    let e = read_member(&idx, "a.xml").unwrap_err();
    assert!(e.0.contains("does not match its declared size"), "{e}");
}

#[test]
fn deflate_bomb_declared_huge_is_refused_before_inflating() {
    let mut zip = build(&[m("a.xml", b"x")], b"");
    let central = zip
        .windows(4)
        .position(|w| w == [0x50, 0x4b, 1, 2])
        .unwrap();
    let huge = 0xffff_fff0u32;
    zip[22..26].copy_from_slice(&huge.to_le_bytes());
    zip[central + 24..central + 28].copy_from_slice(&huge.to_le_bytes());
    let idx = index_zip(&zip).unwrap();
    assert!(read_member(&idx, "a.xml").is_err());
}

#[test]
fn absent_member_is_none() {
    let z = sample();
    assert!(
        read_member(&index_zip(&z).unwrap(), "nope")
            .unwrap()
            .is_none()
    );
}
