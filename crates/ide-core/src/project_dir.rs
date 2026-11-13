//! The per-project config folder (`<root>/.pyforge/`).

use std::path::{Path, PathBuf};

/// Folder name under the project root.
pub const DIR: &str = ".pyforge";

/// Where `rel` (e.g. `settings.toml`) is read from and written to.
pub fn path(root: &Path, rel: impl AsRef<Path>) -> PathBuf {
    root.join(DIR).join(rel)
}
