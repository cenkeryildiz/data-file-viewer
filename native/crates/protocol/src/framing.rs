//! NDJSON framing: one UTF-8 JSON object per `\n`-terminated line, at most `max` bytes per
//! line before the newline (trailing `\r`s tolerated and stripped). Matches
//! `pdf_worker.Worker._frames` byte for byte in its decisions:
//!
//! - a line of `<= max` bytes before `\n` is a frame;
//! - a line longer than `max` is skipped to its newline without being held (`Oversized`);
//! - end of input inside a line of `<= max` bytes is `Truncated` and ends the stream;
//! - end of input inside an over-long line is `Oversized` and ends the stream.
//!
//! Reads are bounded: a frame never holds more than `max` bytes, however the input is split.

use std::io::{self, BufRead};

/// One unit of input.
#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    /// The bytes of one line, without its `\n` and trailing `\r`s.
    Line(Vec<u8>),
    /// Input ended in the middle of a line of at most `max` bytes. Nothing follows.
    Truncated,
    /// A line longer than `max` bytes was discarded.
    Oversized,
}

pub struct FrameReader<R> {
    inner: R,
    max: usize,
    done: bool,
}

impl<R: BufRead> FrameReader<R> {
    pub fn new(inner: R, max: usize) -> Self {
        Self {
            inner,
            max,
            done: false,
        }
    }

    /// The next frame, or `None` at end of input.
    pub fn next_frame(&mut self) -> io::Result<Option<Frame>> {
        if self.done {
            return Ok(None);
        }
        let mut line: Vec<u8> = Vec::new();
        let mut oversized = false;
        loop {
            let buf = match self.inner.fill_buf() {
                Ok(b) => b,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            if buf.is_empty() {
                self.done = true;
                return Ok(if oversized {
                    Some(Frame::Oversized)
                } else if line.is_empty() {
                    None
                } else {
                    Some(Frame::Truncated)
                });
            }
            match buf.iter().position(|&b| b == b'\n') {
                Some(i) => {
                    if !oversized {
                        if line.len() + i > self.max {
                            oversized = true;
                            line = Vec::new();
                        } else {
                            line.extend_from_slice(&buf[..i]);
                        }
                    }
                    self.inner.consume(i + 1);
                    break;
                }
                None => {
                    let n = buf.len();
                    if !oversized {
                        if line.len() + n > self.max {
                            oversized = true;
                            line = Vec::new();
                        } else {
                            line.extend_from_slice(buf);
                        }
                    }
                    self.inner.consume(n);
                }
            }
        }
        if oversized {
            return Ok(Some(Frame::Oversized));
        }
        while line.last() == Some(&b'\r') {
            line.pop();
        }
        Ok(Some(Frame::Line(line)))
    }
}

/// Python's `bytes.strip()` whitespace: a frame of only these is skipped.
pub fn is_blank(line: &[u8]) -> bool {
    line.iter()
        .all(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c))
}
