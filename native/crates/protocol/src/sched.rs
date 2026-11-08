//! Scheduled runtime (D3.3): one serialized engine lane, per-session FIFO queues served round-robin,
//! per-request deadlines, cancellation of queued and active requests, and close that settles a
//! session's requests. Every accepted request is answered exactly once.
//!
//! Active cancellation and deadlines are cooperative: the coordinator answers at once and drops the
//! late result, but the lane stays busy until the engine returns (it polls [`Control::check`]).
//! shortcut: no hard kill of a native call that never polls, add a watchdog when a real engine exists.
use crate::envelope::{self, Incoming};
use crate::errors::*;
use crate::framing::{Frame, FrameReader, is_blank};
use crate::serve::{Capabilities, capabilities_frame_for, send_for};
use crate::{MAX_FRAME_BYTES, UNADDRESSED_ID};
use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct Limits {
    /// Queued (not yet running) requests across all sessions; one more is refused `queue_full`.
    pub queued: usize,
    /// Longest and default request deadline, from receipt (queue time counts).
    pub deadline_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            queued: 8,
            deadline_ms: 90_000,
        }
    }
}

const RUN: u8 = 0;
const CANCELLED_STATE: u8 = 1;
const EXPIRED_STATE: u8 = 2;

/// A write refused before it ran left the source alone; one cut short while running may have changed it.
fn settled(method: &str, ran: bool, error: ErrorBody) -> ErrorBody {
    if is_mutation(method) {
        error.outcome(if ran { "unknown" } else { "not-published" })
    } else {
        error
    }
}

/// What the engine polls while it works.
#[derive(Clone)]
pub struct Control(Arc<(AtomicU8, Instant)>);
impl Control {
    pub fn new(deadline: Instant) -> Self {
        Self(Arc::new((AtomicU8::new(RUN), deadline)))
    }
    /// A control that never fires; for engines called outside the scheduler.
    pub fn unbounded() -> Self {
        Self::new(Instant::now() + Duration::from_secs(60 * 60 * 24 * 365))
    }
    fn stop(&self, state: u8) {
        let _ = self
            .0
            .0
            .compare_exchange(RUN, state, Ordering::SeqCst, Ordering::SeqCst);
    }
    pub fn cancel(&self) {
        self.stop(CANCELLED_STATE);
    }
    pub fn check(&self) -> Result<(), ErrorBody> {
        if self.0.0.load(Ordering::SeqCst) == RUN && Instant::now() >= self.0.1 {
            self.stop(EXPIRED_STATE);
        }
        match self.0.0.load(Ordering::SeqCst) {
            CANCELLED_STATE => Err(ErrorBody::new(CANCELLED, "The request was cancelled.")),
            EXPIRED_STATE => Err(ErrorBody::new(
                DEADLINE_EXCEEDED,
                "The request deadline passed.",
            )),
            _ => Ok(()),
        }
    }
}

/// Where a request queues. `closes` ends `session`: its other requests are settled first.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Route {
    pub session: Option<String>,
    pub closes: bool,
}
pub type Router = fn(&str, &Map<String, Value>) -> Route;

pub trait Lane: 'static {
    fn protocol(&self) -> &'static str {
        crate::PROTOCOL
    }
    fn capabilities(&self) -> Capabilities;
    /// Pure and cheap: the coordinator calls it on its own thread.
    fn router(&self) -> Router {
        |_, _| Route::default()
    }
    /// Called only for listed methods, one at a time.
    fn call(
        &mut self,
        method: &str,
        args: &Map<String, Value>,
        control: &Control,
    ) -> Result<Value, ErrorBody>;
    /// Reclaim owned state from a successful result that could not be delivered to its caller.
    fn discard(&mut self, _method: &str, _result: Value) {}
}

struct Req {
    id: String,
    method: String,
    args: Map<String, Value>,
    route: Route,
    control: Control,
    deadline: Instant,
    frame_bytes: usize,
}
struct Active {
    ticket: u64,
    id: String,
    session: Option<String>,
    control: Control,
    deadline: Instant,
    answered: bool,
    method: String,
}
enum Event {
    Ready(Capabilities, Router, &'static str),
    InitFailed,
    Frame(Frame),
    End,
    Done(u64, Result<Value, ErrorBody>),
    LaneDied,
}
enum Command {
    Run(u64, String, Map<String, Value>, Control),
    Discard(String, Value),
}

pub fn serve_scheduled<F, L, R, W>(factory: F, input: R, out: W, limits: Limits) -> io::Result<i32>
where
    F: FnOnce() -> L + Send + 'static,
    L: Lane,
    R: BufRead + Send + 'static,
    W: Write,
{
    serve_scheduled_with(factory, input, out, MAX_FRAME_BYTES, limits)
}

pub fn serve_scheduled_with<F, L, R, W>(
    factory: F,
    input: R,
    mut out: W,
    max_frame: usize,
    limits: Limits,
) -> io::Result<i32>
where
    F: FnOnce() -> L + Send + 'static,
    L: Lane,
    R: BufRead + Send + 'static,
    W: Write,
{
    // Bounded: the reader parks while the coordinator is busy, so input is never buffered unboundedly.
    let (events_tx, events) = mpsc::sync_channel::<Event>(1);
    let (run_tx, run_rx) = mpsc::channel::<Command>();
    let lane_events = events_tx.clone();
    let lane_thread = std::thread::Builder::new()
        .name("table-lane".into())
        .spawn(move || {
            let mut lane = match catch_unwind(AssertUnwindSafe(factory)) {
                Ok(lane) => lane,
                Err(_) => return drop(lane_events.send(Event::InitFailed)),
            };
            if lane_events
                .send(Event::Ready(
                    lane.capabilities(),
                    lane.router(),
                    lane.protocol(),
                ))
                .is_err()
            {
                return;
            }
            while let Ok(command) = run_rx.recv() {
                let (ticket, method, args, control) = match command {
                    Command::Run(ticket, method, args, control) => (ticket, method, args, control),
                    Command::Discard(method, result) => {
                        if catch_unwind(AssertUnwindSafe(|| lane.discard(&method, result))).is_err()
                        {
                            return drop(lane_events.send(Event::LaneDied));
                        }
                        continue;
                    }
                };
                let result = catch_unwind(AssertUnwindSafe(|| lane.call(&method, &args, &control)));
                let Ok(result) = result else {
                    // A panicked engine is not trusted again.
                    return drop(lane_events.send(Event::LaneDied));
                };
                if lane_events.send(Event::Done(ticket, result)).is_err() {
                    return;
                }
            }
        })?;
    let (caps, router, protocol) = match events.recv() {
        Ok(Event::Ready(caps, router, protocol)) if !caps.methods.is_empty() => {
            (caps, router, protocol)
        }
        Ok(Event::Ready(..)) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "capabilities list no methods",
            ));
        }
        _ => return Ok(1),
    };
    send_for(
        &mut out,
        &capabilities_frame_for(&caps, max_frame, &limits, protocol),
        max_frame,
        UNADDRESSED_ID,
        protocol,
    )?;
    let reader_events = events_tx;
    std::thread::Builder::new()
        .name("table-input".into())
        .spawn(move || {
            let mut frames = FrameReader::new(input, max_frame);
            while let Ok(Some(frame)) = frames.next_frame() {
                let last = matches!(frame, Frame::Truncated);
                if reader_events.send(Event::Frame(frame)).is_err() || last {
                    break;
                }
            }
            let _ = reader_events.send(Event::End);
        })?;
    // The coordinator (and its run_tx) drops at the end of this statement, which ends the lane loop.
    let status = Coordinator {
        protocol,
        out,
        max_frame,
        limits,
        caps,
        router,
        run_tx,
        queues: HashMap::new(),
        ready: VecDeque::new(),
        active: None,
        tickets: 0,
        ending: false,
    }
    .run(&events);
    // Graceful end only (nothing active): join so the engine's destructor removes its private scratch
    // before the process exits. A failed run may have a stuck lane, so it is not waited for.
    if matches!(status, Ok(0)) {
        let _ = lane_thread.join();
    }
    status
}

struct Coordinator<W> {
    protocol: &'static str,
    out: W,
    max_frame: usize,
    limits: Limits,
    caps: Capabilities,
    router: Router,
    run_tx: Sender<Command>,
    queues: HashMap<Option<String>, VecDeque<Req>>,
    /// Session keys with work, served round-robin so one busy session cannot starve another.
    ready: VecDeque<Option<String>>,
    active: Option<Active>,
    tickets: u64,
    ending: bool,
}

impl<W: Write> Coordinator<W> {
    fn reply(&mut self, id: &str, result: Result<Value, ErrorBody>) -> io::Result<()> {
        let frame = match result {
            Ok(v) => envelope::success_for(id, v, self.protocol),
            Err(e) => envelope::failure_for(id, &e, self.protocol),
        };
        send_for(&mut self.out, &frame, self.max_frame, id, self.protocol).map(|_| ())
    }

    fn run(&mut self, events: &Receiver<Event>) -> io::Result<i32> {
        loop {
            self.dispatch()?;
            if self.ending && self.active.is_none() && self.queues.values().all(VecDeque::is_empty)
            {
                return Ok(0);
            }
            let event = match self.next_deadline() {
                Some(at) => match events.recv_timeout(at.saturating_duration_since(Instant::now()))
                {
                    Ok(e) => Some(e),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return Ok(1),
                },
                None => Some(
                    events
                        .recv()
                        .map_err(|_| io::Error::other("input and lane gone"))?,
                ),
            };
            match event {
                None | Some(Event::Ready(..) | Event::InitFailed) => {}
                Some(Event::Frame(frame)) => self.frame(frame)?,
                Some(Event::End) => self.ending = true,
                Some(Event::Done(ticket, result)) => {
                    if self.active.as_ref().is_some_and(|a| a.ticket == ticket) {
                        let a = self.active.take().unwrap();
                        let refused = a.control.check().err();
                        if a.answered || refused.is_some() {
                            // The write ran to its end: say what it did, not that it was cut short.
                            let outcome = match &result {
                                Ok(v) if v["outcome"] == "published" => "published",
                                Ok(_) => "not-published",
                                Err(e) => e.mutation_outcome.unwrap_or("unknown"),
                            };
                            if let Ok(value) = result {
                                self.discard(a.method.clone(), value)?;
                            }
                            if !a.answered {
                                let mut error = refused.expect("deadline passed");
                                if is_mutation(&a.method) {
                                    error = error.outcome(outcome);
                                }
                                self.reply(&a.id, Err(error))?;
                            }
                        } else if let Ok(value) = result {
                            let mut frame = envelope::success_for(&a.id, value, self.protocol);
                            if !send_for(
                                &mut self.out,
                                &frame,
                                self.max_frame,
                                &a.id,
                                self.protocol,
                            )? {
                                self.discard(a.method, frame["result"].take())?;
                            }
                        } else {
                            self.reply(&a.id, result)?;
                        }
                    }
                }
                Some(Event::LaneDied) => return self.lane_died(),
            }
            self.expire()?;
        }
    }

    fn frame(&mut self, frame: Frame) -> io::Result<()> {
        let line = match frame {
            Frame::Line(line) if is_blank(&line) => return Ok(()),
            Frame::Line(line) => line,
            Frame::Oversized => {
                let e = ErrorBody::new(
                    MALFORMED_REQUEST,
                    format!("Frame exceeds {} bytes.", self.max_frame),
                );
                return self.reply(UNADDRESSED_ID, Err(e));
            }
            Frame::Truncated => {
                self.ending = true;
                return self.reply(
                    UNADDRESSED_ID,
                    Err(ErrorBody::new(
                        MALFORMED_REQUEST,
                        "Input ended inside a frame.",
                    )),
                );
            }
        };
        match envelope::decode_for(&line, self.protocol) {
            Err((id, e)) => self.reply(&id, Err(e)),
            Ok(Incoming::Cancel { id }) => self.cancel(&id),
            Ok(Incoming::Request {
                id,
                method,
                args,
                deadline_ms,
            }) => self.admit(id, method, args, deadline_ms, line.len()),
        }
    }

    fn admit(
        &mut self,
        id: String,
        method: String,
        args: Map<String, Value>,
        deadline_ms: Option<u64>,
        frame_bytes: usize,
    ) -> io::Result<()> {
        if !self.caps.methods.contains(&method.as_str()) {
            return self.reply(&id, Err(ErrorBody::new(UNKNOWN_METHOD, "Unknown method.")));
        }
        let live = self
            .active
            .as_ref()
            .is_some_and(|a| !a.answered && a.id == id)
            || self.queues.values().flatten().any(|r| r.id == id);
        if live {
            return self.reply(
                &id,
                Err(ErrorBody::new(
                    MALFORMED_REQUEST,
                    "A request with this id is already in flight.",
                )),
            );
        }
        let wait =
            Duration::from_millis(deadline_ms.unwrap_or(u64::MAX).min(self.limits.deadline_ms));
        let deadline = Instant::now() + wait;
        let route = (self.router)(&method, &args);
        let key = route.session.clone();
        let queued = self
            .queues
            .values()
            .flatten()
            .filter(|request| !route.closes || request.route.session != key);
        if queued.clone().count() >= self.limits.queued
            || frame_bytes
                > self
                    .max_frame
                    .saturating_sub(queued.map(|r| r.frame_bytes).sum())
        {
            return self.reply(
                &id,
                Err(ErrorBody::new(
                    QUEUE_FULL,
                    "The waiting request count or byte budget is full; retry shortly.",
                )),
            );
        }
        if route.closes {
            self.settle_session(&key)?;
        }
        let req = Req {
            id,
            method,
            args,
            route: route.clone(),
            control: Control::new(deadline),
            deadline,
            frame_bytes,
        };
        let queue = self.queues.entry(key.clone()).or_default();
        if queue.is_empty() {
            self.ready.push_back(key);
        }
        // A close runs next in its session: everything older was just settled.
        if route.closes {
            queue.push_front(req)
        } else {
            queue.push_back(req)
        }
        Ok(())
    }

    /// Close: answer every queued request of the session and the active one `cancelled` now.
    fn settle_session(&mut self, key: &Option<String>) -> io::Result<()> {
        let queued: Vec<Req> = self
            .queues
            .get_mut(key)
            .map(|q| q.drain(..).collect())
            .unwrap_or_default();
        self.prune_queues();
        for r in queued {
            let error = ErrorBody::new(CANCELLED, "The document was closed.");
            self.reply(&r.id, Err(settled(&r.method, false, error)))?;
        }
        if let Some(a) = self
            .active
            .as_mut()
            .filter(|a| !a.answered && &a.session == key)
        {
            a.control.cancel();
            a.answered = true;
            let (id, method) = (a.id.clone(), a.method.clone());
            let error = ErrorBody::new(CANCELLED, "The document was closed.");
            self.reply(&id, Err(settled(&method, true, error)))?;
        }
        Ok(())
    }

    fn cancel(&mut self, id: &str) -> io::Result<()> {
        for q in self.queues.values_mut() {
            if let Some(at) = q.iter().position(|r| r.id == id) {
                let removed = q.remove(at).expect("position found");
                self.prune_queues();
                let error = ErrorBody::new(CANCELLED, "The request was cancelled.");
                return self.reply(id, Err(settled(&removed.method, false, error)));
            }
        }
        if let Some(a) = self.active.as_mut().filter(|a| !a.answered && a.id == id) {
            a.control.cancel();
            a.answered = true;
            let method = a.method.clone();
            let error = ErrorBody::new(CANCELLED, "The request was cancelled.");
            return self.reply(id, Err(settled(&method, true, error)));
        }
        Ok(()) // already settled, or never seen: a late cancel is not an error and gets no reply
    }

    fn dispatch(&mut self) -> io::Result<()> {
        while self.active.is_none() {
            let Some(key) = self.ready.pop_front() else {
                return Ok(());
            };
            let Some(queue) = self.queues.get_mut(&key) else {
                continue;
            };
            let Some(req) = queue.pop_front() else {
                continue;
            };
            if !queue.is_empty() {
                self.ready.push_back(key.clone());
            }
            self.prune_queues();
            self.tickets += 1;
            if Instant::now() >= req.deadline {
                let error = ErrorBody::new(DEADLINE_EXCEEDED, "The request deadline passed.");
                self.reply(&req.id, Err(settled(&req.method, false, error)))?;
                continue;
            }
            let method = req.method.clone();
            let run = Command::Run(self.tickets, req.method, req.args, req.control.clone());
            if self.run_tx.send(run).is_err() {
                return self.reply(
                    &req.id,
                    Err(ErrorBody::new(WORKER_FAILED, "The engine is not running.")),
                );
            }
            self.active = Some(Active {
                ticket: self.tickets,
                id: req.id,
                session: req.route.session,
                control: req.control,
                deadline: req.deadline,
                answered: false,
                method,
            });
        }
        Ok(())
    }

    fn next_deadline(&self) -> Option<Instant> {
        let queued = self.queues.values().flatten().map(|r| r.deadline);
        let active = self
            .active
            .iter()
            .filter(|a| !a.answered)
            .map(|a| a.deadline);
        queued.chain(active).min()
    }

    fn expire(&mut self) -> io::Result<()> {
        let now = Instant::now();
        let mut late = Vec::new();
        for q in self.queues.values_mut() {
            let (gone, keep): (VecDeque<Req>, VecDeque<Req>) = std::mem::take(q)
                .into_iter()
                .partition(|r| r.deadline <= now);
            *q = keep;
            late.extend(gone.into_iter().map(|r| (r.id, r.method, false)));
        }
        self.prune_queues();
        if let Some(a) = self
            .active
            .as_mut()
            .filter(|a| !a.answered && a.deadline <= now)
        {
            a.control.check().ok();
            a.answered = true;
            late.push((a.id.clone(), a.method.clone(), true));
        }
        for (id, method, ran) in late {
            let error = ErrorBody::new(DEADLINE_EXCEEDED, "The request deadline passed.");
            self.reply(&id, Err(settled(&method, ran, error)))?;
        }
        Ok(())
    }

    fn prune_queues(&mut self) {
        self.queues.retain(|_, queue| !queue.is_empty());
        self.ready.retain(|key| self.queues.contains_key(key));
    }

    fn discard(&self, method: String, result: Value) -> io::Result<()> {
        self.run_tx
            .send(Command::Discard(method, result))
            .map_err(|_| io::Error::other("The engine could not reclaim an undelivered result."))
    }

    fn lane_died(&mut self) -> io::Result<i32> {
        let mut ids: Vec<(String, String, bool)> = self
            .active
            .take()
            .filter(|a| !a.answered)
            .map(|a| (a.id, a.method, true))
            .into_iter()
            .collect();
        ids.extend(
            self.queues
                .values_mut()
                .flat_map(|q| q.drain(..).map(|r| (r.id, r.method, false))),
        );
        for (id, method, ran) in ids {
            let error = ErrorBody::new(WORKER_FAILED, "The engine failed.");
            self.reply(&id, Err(settled(&method, ran, error)))?;
        }
        Ok(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PROTOCOL, VERSION};
    use serde_json::json;

    fn coordinator(max_frame: usize, queued: usize) -> (Coordinator<Vec<u8>>, Receiver<Command>) {
        let (run_tx, commands) = mpsc::channel();
        let coordinator = Coordinator {
            protocol: crate::PROTOCOL,
            out: Vec::new(),
            max_frame,
            limits: Limits {
                queued,
                deadline_ms: 30_000,
            },
            caps: Capabilities {
                name: "test",
                version: "0",
                methods: vec!["ok", "close"],
                formats: vec![],
                value_tags: vec![],
                time_units: vec![],
            },
            router: |method, args| Route {
                session: args
                    .get("session")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                closes: method == "close",
            },
            run_tx,
            queues: HashMap::new(),
            ready: VecDeque::new(),
            active: None,
            tickets: 0,
            ending: false,
        };
        (coordinator, commands)
    }

    fn request(id: u64, session: &str) -> Value {
        json!({"protocol": PROTOCOL, "version": VERSION, "kind": "request", "id": id.to_string(), "method": "ok", "args": {"session": session}})
    }

    fn frame(coordinator: &mut Coordinator<Vec<u8>>, value: &Value) {
        coordinator
            .frame(Frame::Line(serde_json::to_vec(value).unwrap()))
            .unwrap();
    }

    fn replies(coordinator: &Coordinator<Vec<u8>>) -> Vec<Value> {
        coordinator
            .out
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    #[test]
    fn unknown_session_and_close_requests_share_one_global_queue_limit() {
        let (mut c, _commands) = coordinator(16_384, 8);
        for id in 1..=64 {
            let mut input = request(id, &format!("unknown-{id}"));
            if id % 2 == 0 {
                input["method"] = json!("close");
            }
            frame(&mut c, &input);
        }
        assert_eq!(c.queues.values().map(VecDeque::len).sum::<usize>(), 8);
        assert_eq!((c.queues.len(), c.ready.len()), (8, 8));
        assert_eq!(replies(&c).len(), 56);
        assert!(replies(&c).iter().all(|r| r["error"]["code"] == QUEUE_FULL));
    }

    #[test]
    fn byte_budget_is_reclaimed_by_cancel_and_refused_close_has_no_side_effects() {
        let (mut c, _commands) = coordinator(800, 8);
        let mut large = request(1, "a");
        large["args"]["padding"] = json!("x".repeat(400));
        frame(&mut c, &large);
        large["id"] = json!("2");
        large["args"]["session"] = json!("b");
        frame(&mut c, &large);
        assert_eq!(replies(&c)[0]["error"]["code"], QUEUE_FULL);
        c.cancel("1").unwrap();
        assert!(c.queues.is_empty() && c.ready.is_empty());
        frame(&mut c, &large);
        assert_eq!(c.queues.values().flatten().next().unwrap().id, "2");

        let (mut c, _commands) = coordinator(1024, 1);
        frame(&mut c, &request(3, "a"));
        let mut close = request(4, "b");
        close["method"] = json!("close");
        frame(&mut c, &close);
        assert_eq!(replies(&c)[0]["error"]["code"], QUEUE_FULL);
        assert_eq!(c.queues.values().flatten().next().unwrap().id, "3");
        close["args"]["session"] = json!("a");
        frame(&mut c, &close);
        assert_eq!(c.queues.values().flatten().next().unwrap().id, "4");
        assert_eq!(replies(&c)[1]["error"]["code"], CANCELLED);
        c.cancel("4").unwrap();
        assert!(c.queues.is_empty() && c.ready.is_empty());
    }

    #[test]
    fn expiry_and_dispatch_do_not_retain_empty_session_keys_or_ready_entries() {
        let (mut c, commands) = coordinator(1024, 8);
        for id in 1..=256 {
            let mut input = request(id, &format!("unknown-{id}"));
            input["deadline_ms"] = json!("0");
            frame(&mut c, &input);
            c.expire().unwrap();
            assert!(c.queues.is_empty() && c.ready.is_empty());
            input.as_object_mut().unwrap().remove("deadline_ms");
            frame(&mut c, &input);
            c.dispatch().unwrap();
            assert!(matches!(commands.recv().unwrap(), Command::Run(..)));
            assert!(c.queues.is_empty() && c.ready.is_empty());
            c.active.take();
        }
    }

    #[test]
    fn cancellation_after_call_return_discards_the_result_before_the_next_run() {
        struct Completed;
        impl Lane for Completed {
            fn capabilities(&self) -> Capabilities {
                Capabilities {
                    name: "test",
                    version: "0",
                    methods: vec!["ok"],
                    formats: vec![],
                    value_tags: vec![],
                    time_units: vec![],
                }
            }
            fn call(
                &mut self,
                _: &str,
                _: &Map<String, Value>,
                _: &Control,
            ) -> Result<Value, ErrorBody> {
                Ok(json!({"resource": "owned-result"}))
            }
        }
        let (mut c, commands) = coordinator(1024, 8);
        frame(&mut c, &request(1, "a"));
        c.dispatch().unwrap();
        assert!(matches!(commands.recv().unwrap(), Command::Run(1, ..)));
        frame(&mut c, &request(2, "b"));
        let completed = Completed
            .call("ok", &Map::new(), &Control::unbounded())
            .unwrap();
        let (events, received) = mpsc::channel();
        events
            .send(Event::Frame(Frame::Line(
                serde_json::to_vec(
                    &json!({"protocol": PROTOCOL, "version": VERSION, "kind": "cancel", "id": "1"}),
                )
                .unwrap(),
            )))
            .unwrap();
        events.send(Event::Done(1, Ok(completed.clone()))).unwrap();
        events.send(Event::Done(2, Ok(json!({})))).unwrap();
        events.send(Event::End).unwrap();
        assert_eq!(c.run(&received).unwrap(), 0);
        assert!(
            matches!(commands.recv().unwrap(), Command::Discard(method, value) if method == "ok" && value == completed)
        );
        assert!(matches!(commands.recv().unwrap(), Command::Run(2, ..)));
        let replies = replies(&c);
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["error"]["code"], CANCELLED);
        assert_eq!(replies[1]["ok"], true);
    }

    #[test]
    fn late_deadline_and_oversized_successes_are_discarded() {
        for oversized in [false, true] {
            let (mut c, commands) = coordinator(1024, 8);
            frame(&mut c, &request(1, "a"));
            c.dispatch().unwrap();
            assert!(matches!(commands.recv().unwrap(), Command::Run(1, ..)));
            if !oversized {
                c.active.as_mut().unwrap().control = Control::new(Instant::now());
            }
            let value =
                json!({"resource": "owned", "padding": "x".repeat(if oversized {2048} else {0})});
            let (events, received) = mpsc::channel();
            events.send(Event::Done(1, Ok(value.clone()))).unwrap();
            events.send(Event::End).unwrap();
            assert_eq!(c.run(&received).unwrap(), 0);
            assert!(
                matches!(commands.recv().unwrap(), Command::Discard(_, discarded) if discarded == value)
            );
            assert_eq!(
                replies(&c)[0]["error"]["code"],
                if oversized {
                    RESOURCE_LIMIT
                } else {
                    DEADLINE_EXCEEDED
                }
            );
        }
    }

    #[test]
    fn an_error_completed_after_its_deadline_reports_deadline_without_discarding() {
        let (mut c, commands) = coordinator(1024, 8);
        frame(&mut c, &request(1, "a"));
        c.dispatch().unwrap();
        assert!(matches!(commands.recv().unwrap(), Command::Run(1, ..)));
        c.active.as_mut().unwrap().control = Control::new(Instant::now());
        let (events, received) = mpsc::channel();
        events
            .send(Event::Done(
                1,
                Err(ErrorBody::new(QUERY_FAILED, "late failure")),
            ))
            .unwrap();
        events.send(Event::End).unwrap();
        assert_eq!(c.run(&received).unwrap(), 0);
        assert_eq!(replies(&c)[0]["error"]["code"], DEADLINE_EXCEEDED);
        assert!(commands.try_recv().is_err());
    }
}
