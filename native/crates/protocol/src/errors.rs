//! `error.v1.schema.json`: the closed code set and its category/retryable defaults.
use serde_json::{Value, json};

macro_rules! codes {
    ($($name:ident = $code:literal, $category:literal, $retryable:literal;)*) => {
        $(pub const $name: &str = $code;)*
        /// `(code, category, retryable)` in schema order.
        pub const CODES: &[(&str, &str, bool)] = &[$(($code, $category, $retryable)),*];
    };
}
codes! {
    MALFORMED_REQUEST = "malformed_request", "syntax", false;
    MALFORMED_VALUE = "malformed_value", "conversion", false;
    UNKNOWN_METHOD = "unknown_method", "unknown", false;
    NOT_OPEN = "not_open", "unknown", false;
    ALREADY_OPEN = "already_open", "unknown", false;
    POLICY_REFUSED = "policy_refused", "blocked", false;
    READ_ONLY = "read_only", "blocked", false;
    STALE_SOURCE = "stale_source", "unknown", false;
    QUEUE_FULL = "queue_full", "resource", true;
    RUNTIME_BUSY = "runtime_busy", "resource", true;
    CANCELLED = "cancelled", "cancelled", false;
    DEADLINE_EXCEEDED = "deadline_exceeded", "resource", true;
    WORKER_FAILED = "worker_failed", "unknown", false;
    QUERY_FAILED = "query_failed", "unknown", false;
    RESOURCE_LIMIT = "resource_limit", "resource", false;
    AMBIGUOUS_ROW = "ambiguous_row", "unknown", false;
    NO_MATCHING_ROW = "no_matching_row", "unknown", false;
    TABLE_CHANGED = "table_changed", "unknown", false;
    MUTATION_NOT_PUBLISHED = "mutation_not_published", "unknown", false;
    MUTATION_UNKNOWN = "mutation_unknown", "unknown", false;
    UNSUPPORTED = "unsupported", "blocked", false;
}

/// A typed error answer. `message` is user-safe text: never engine errors, SQL or values.
#[derive(Debug, Clone, PartialEq)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    /// What a write left on disk: `not-published`, `published` or `unknown`. `None` only for reads.
    pub mutation_outcome: Option<&'static str>,
}

/// Methods that can change a source or its backup; their failures must say what is on disk.
pub fn is_mutation(method: &str) -> bool {
    matches!(method, "updateCell" | "createBackup" | "setSafeMode")
}

impl ErrorBody {
    /// `code` must be one of [`CODES`]; a write adds its outcome with [`ErrorBody::outcome`].
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        debug_assert!(
            CODES.iter().any(|(c, _, _)| *c == code),
            "unknown code {code}"
        );
        Self {
            code,
            message: message.into(),
            mutation_outcome: None,
        }
    }

    pub fn outcome(mut self, outcome: &'static str) -> Self {
        debug_assert!(matches!(outcome, "not-published" | "published" | "unknown"));
        self.mutation_outcome = Some(outcome);
        self
    }

    pub fn to_value(&self) -> Value {
        let (_, category, retryable) = CODES
            .iter()
            .find(|(c, _, _)| *c == self.code)
            .copied()
            .unwrap_or((self.code, "unknown", false));
        json!({"code": self.code, "category": category, "message": self.message, "retryable": retryable, "mutation_outcome": self.mutation_outcome})
    }
}
