//! Safe Mode state, as the TS provider keeps it: on = edits blocked; turning it off may take a backup first, and a failed
//! backup leaves it on.
use crate::backup::{Backup, BackupError};

pub const DEFAULT_DIFF_ROW_THRESHOLD: usize = 50_000;

/// `dataFileViewer.diffRowThreshold`: anything that is not a finite positive number falls back to the default.
pub fn diff_row_threshold(setting: Option<f64>) -> usize {
    match setting {
        Some(v) if v.is_finite() && v > 0.0 => v.min(usize::MAX as f64) as usize,
        _ => DEFAULT_DIFF_ROW_THRESHOLD,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeMode {
    enabled: bool,
    pub backup_before_write: bool,
    pub check_for_changes: bool,
    has_backup: bool,
}
impl Default for SafeMode {
    fn default() -> Self {
        Self {
            enabled: true,
            backup_before_write: true,
            check_for_changes: true,
            has_backup: false,
        }
    }
}
impl SafeMode {
    pub fn enabled(&self) -> bool {
        self.enabled
    }
    pub fn has_backup(&self) -> bool {
        self.has_backup
    }
    pub fn edits_allowed(&self) -> bool {
        !self.enabled
    }
    /// Turning Safe Mode off. With `backup_before_write` the backup must succeed first; on failure Safe Mode stays on.
    pub fn turn_off(
        &mut self,
        make_backup: impl FnOnce() -> Result<Backup, BackupError>,
    ) -> Result<Option<Backup>, BackupError> {
        if !self.enabled {
            return Ok(None);
        }
        if self.backup_before_write {
            let backup = make_backup()?;
            if !backup.receipt.durable || !backup.intact() {
                return Err(BackupError::Unverified);
            }
            self.has_backup = true;
            self.enabled = false;
            return Ok(Some(backup));
        }
        self.enabled = false;
        Ok(None)
    }
    /// Re-lock. Returns whether the caller should now compare the tables against the backup.
    pub fn turn_on(&mut self) -> bool {
        let was_off = !self.enabled;
        self.enabled = true;
        was_off && self.check_for_changes && self.has_backup
    }
    /// Whether the automatic post-query diff runs: the TS skips it above the threshold (the user can ask for it on demand).
    pub fn should_auto_diff(&self, result_rows: usize, threshold: usize) -> bool {
        self.check_for_changes && self.has_backup && result_rows <= threshold
    }
}
