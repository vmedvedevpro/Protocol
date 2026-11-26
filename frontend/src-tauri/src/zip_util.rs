//! Writing the ZIPs a user saves: Save logs (`app_log::bundle`) and the
//! crash report (`crash_report.rs`).

use std::fs;
use std::io::{self, Write};
use std::path::Path;
use tempfile::NamedTempFile;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Whether `path` names a `.zip` file, in any case; the save dialogs offer
/// only that, and a path from the WebView is checked again here.
pub fn is_zip(path: &Path) -> bool {
    path.extension().is_some_and(|value| value.eq_ignore_ascii_case("zip"))
}

/// The ZIP being written by [`write_zip`].
pub struct ZipEntries<'a> {
    zip: ZipWriter<&'a mut fs::File>,
    count: usize,
}

impl ZipEntries<'_> {
    pub fn add(&mut self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        self.zip.start_file(name, options)?;
        self.zip.write_all(bytes)?;
        self.count += 1;
        Ok(())
    }
}

/// Writes a ZIP that `fill` adds the files to, through a temporary file
/// beside `destination`, so a failed save leaves no half file; returns how
/// many files it holds.
pub fn write_zip(
    destination: &Path,
    fill: impl FnOnce(&mut ZipEntries<'_>) -> io::Result<()>,
) -> io::Result<usize> {
    if !is_zip(destination) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Only a .zip file can be written"));
    }
    let parent = destination.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    if !parent.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "The folder to save in does not exist"));
    }
    let mut temporary = NamedTempFile::new_in(parent)?;
    let count = {
        let mut entries = ZipEntries { zip: ZipWriter::new(temporary.as_file_mut()), count: 0 };
        fill(&mut entries)?;
        entries.zip.finish()?;
        entries.count
    };
    temporary.as_file().sync_all()?;
    temporary.persist(destination).map_err(|error| error.error)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_zip_name_passes() {
        assert!(is_zip(Path::new("/x/logs.zip")) && is_zip(Path::new("logs.ZIP")));
        assert!(!is_zip(Path::new("/x/logs")) && !is_zip(Path::new("/x/logs.zip.txt")));
    }
}
