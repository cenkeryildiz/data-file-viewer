# D1.7 serialized dataset session extraction

Base: a96bc31, preserved first reference-adapter commit. Applicable AGENTS.md read. Scope only this isolated d1-7 branch; no MOD02/PERFX1/SAFEX1 or D1.8/9 changes.

Add host-free backend/session.ts. DatasetSession owns the open file, captured factory, optional save-notice sink, exact existing queue accounting, busy/closed state, refresh/open replacement and close/drain. Host callbacks supply execution-time authorization, immediate closing cleanup, optional pre-disposal backup summary, and post-disposal cleanup/filesystem-lock release. URI, VS Code notifications/configuration, scheduler and catalog/selection ownership remain in the provider. Existing file, isBusy, runExclusive, tryRunExclusive and disposed access become compatibility delegates.

Preserve the eight-live-job/hard64-depth limits, unique queued-check identities, stale-read supersession and unguarded saves, failure-settled chains and nonblocking live ticks. Closing marks closed immediately, clears host selection/live state, interrupts reads, rejects queued jobs at execution, then drains an active trusted save before summary/file disposal/lock release. Supported save-notice sinks survive closure. Keep current idle cleanup timing, error identities and no mutation retry.

Reconnect remains inside the same host serialized operations, delegating in-place read-only refresh or fresh open/swap to the session. Read host settings only when needed, preserve invalidation before disposing the old file, retain old file on open failure and dispose late handles after close.

Validate host-free lifecycle/queue flood/repeated refresh/two-session/save-close/late-open/error tests; backend import/standalone compile boundary; existing provider lifecycle, security, seven-format save, source/backup and actual close-during-save cases. Run proportional full unit/security and changed-source VSIX/package/installed-host gates under the shared heavy-test lock. Exact source hashes and terminal results are required; whole D1.7 remains open.
