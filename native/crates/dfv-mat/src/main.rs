//! `dfv-mat --stdio`: the native table worker, protocol v1 over stdin/stdout.
//!
//! Stdout is the protocol, so it is guarded at the descriptor level as in `dfv-pdf`: the real
//! stdout is duplicated to a private close-on-exec descriptor only the frame writer holds, then
//! descriptor 1 is pointed at stderr and descriptor 0 at /dev/null. Diagnostics are
//! `mat_worker:`-prefixed stderr lines and never carry file contents.

use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::process::ExitCode;

const USAGE: &str = "usage: dfv-mat --stdio";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--stdio"] => {}
        ["--help"] | ["-h"] => {
            println!(
                "{USAGE}\n\nMAT read-only worker (NDJSON over stdio, protocol v1).\n  --stdio  speak the protocol on stdin/stdout (the only transport)"
            );
            return ExitCode::SUCCESS;
        }
        ["--version"] => {
            println!(
                "dfv-mat {} (protocol 1; read-only MATLAB Level-5)",
                env!("CARGO_PKG_VERSION")
            );
            return ExitCode::SUCCESS;
        }
        _ => {
            eprintln!("{USAGE}\ndfv-mat: error: the following arguments are required: --stdio");
            return ExitCode::from(2);
        }
    }
    // Panics are reported by location only: a payload could quote file contents.
    std::panic::set_hook(Box::new(|info| {
        let at = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".into());
        eprintln!("mat_worker: ERROR panic at {at}");
    }));
    let (proto_in, proto_out) = match isolate_stdio() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("mat_worker: ERROR cannot isolate stdio ({:?})", e.kind());
            return ExitCode::from(1);
        }
    };
    let mut out = BufWriter::new(proto_out);
    let input = BufReader::with_capacity(1 << 16, proto_in);
    let limits = dfv_table_protocol::Limits::default();
    let status = dfv_table_protocol::sched::serve_scheduled_with(
        dfv_mat::Worker::default,
        input,
        &mut out,
        dfv_mat::MAX_FRAME_BYTES,
        limits,
    )
    .unwrap_or(1);
    let _ = out.flush();
    ExitCode::from(u8::try_from(status).unwrap_or(1))
}

#[cfg(unix)]
fn isolate_stdio() -> std::io::Result<(File, File)> {
    use std::os::fd::{AsFd, AsRawFd};
    let _ = std::io::stdout().flush();
    // try_clone_to_owned is F_DUPFD_CLOEXEC: the copies are not inherited by children.
    let proto_out = File::from(std::io::stdout().as_fd().try_clone_to_owned()?);
    let proto_in = File::from(std::io::stdin().as_fd().try_clone_to_owned()?);
    let devnull = File::open("/dev/null")?;
    // SAFETY: dup2 on descriptors this process owns; 0/1/2 stay open throughout.
    unsafe {
        if libc::dup2(2, 1) < 0 || libc::dup2(devnull.as_raw_fd(), 0) < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok((proto_in, proto_out))
}

#[cfg(not(unix))]
fn isolate_stdio() -> std::io::Result<(File, File)> {
    // shortcut: no descriptor redirection on Windows, port SetStdHandle when a Windows target is qualified.
    use std::os::windows::io::AsHandle;
    let proto_out = File::from(std::io::stdout().as_handle().try_clone_to_owned()?);
    let proto_in = File::from(std::io::stdin().as_handle().try_clone_to_owned()?);
    Ok((proto_in, proto_out))
}
