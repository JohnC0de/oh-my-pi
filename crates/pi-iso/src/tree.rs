//! Helpers shared by the backends that materialize `merged` as a real
//! directory tree (rcopy, Linux reflink, Windows block clone) and by the
//! backends that validate a `lower` source directory.

use std::{
	ffi::OsStr,
	fs::{self, FileType},
	io,
	path::{Path, PathBuf},
};

use crate::{IsoError, IsoResult};

thread_local! {
	static CLONE_STATS: std::cell::RefCell<Option<crate::CloneStats>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn measure_clone(
	copy: impl FnOnce() -> IsoResult<()>,
) -> Result<crate::CloneStats, crate::CloneError> {
	let previous = CLONE_STATS.with(|stats| stats.replace(Some(crate::CloneStats::default())));
	let started = std::time::Instant::now();
	let result = copy();
	let mut measured = CLONE_STATS
		.with(|stats| stats.replace(previous))
		.unwrap_or_default();
	measured.total_ms = started.elapsed().as_secs_f64() * 1000.0;
	match result {
		Ok(()) => Ok(measured),
		Err(error) => Err(crate::CloneError { error, stats: Box::new(measured) }),
	}
}

fn record(update: impl FnOnce(&mut crate::CloneStats)) {
	CLONE_STATS.with(|stats| {
		if let Some(stats) = stats.borrow_mut().as_mut() {
			update(stats);
		}
	});
}

/// Resolves `path` against the current directory, checks that it is a
/// directory, and canonicalizes it when possible. `what` names the source in
/// error messages; `make_err` picks the error class, since some backends
/// report a bad source as unavailable so the caller falls back.
pub fn canonical_existing_dir(
	path: &Path,
	what: &str,
	make_err: fn(String) -> IsoError,
) -> IsoResult<PathBuf> {
	let resolved = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
	let meta = fs::metadata(&resolved)
		.map_err(|err| make_err(format!("invalid {what} {}: {err}", resolved.display())))?;
	if !meta.is_dir() {
		return Err(make_err(format!("{what} {} is not a directory", resolved.display())));
	}
	Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
}

/// Reject overlapping trees before creating or removing anything. Resolve each
/// existing ancestor, including symlinks, even when the leaf does not exist.
pub fn validate_destination(source: &Path, destination: &Path) -> IsoResult<()> {
	fn resolve(path: &Path) -> io::Result<PathBuf> {
		let absolute = std::path::absolute(path)?;
		let mut resolved = PathBuf::new();
		for component in absolute.components() {
			match component {
				std::path::Component::ParentDir => {
					resolved.pop();
				},
				std::path::Component::CurDir => {},
				other => {
					resolved.push(other.as_os_str());
					match fs::canonicalize(&resolved) {
						Ok(canonical) => resolved = canonical,
						Err(err) if err.kind() == io::ErrorKind::NotFound => {},
						Err(err) => return Err(err),
					}
				},
			}
		}
		Ok(resolved)
	}
	let source = resolve(source).map_err(|err| IsoError::other(err.to_string()))?;
	let destination = resolve(destination).map_err(|err| IsoError::other(err.to_string()))?;
	#[cfg(unix)]
	let file_identity = |path: &Path| -> io::Result<(u64, u64)> {
		use std::os::unix::fs::MetadataExt;
		let metadata = fs::metadata(path)?;
		Ok((metadata.dev(), metadata.ino()))
	};
	#[cfg(not(unix))]
	let file_identity = |path: &Path| same_file::Handle::from_path(path);
	let identity = file_identity(&source).map_err(|err| IsoError::other(err.to_string()))?;
	for ancestor in destination.ancestors() {
		match file_identity(ancestor) {
			Ok(handle) if handle == identity => {
				return Err(IsoError::other("source and destination trees overlap (file identity)"));
			},
			Ok(_) => {},
			Err(err) if err.kind() == io::ErrorKind::NotFound => {},
			Err(err) => return Err(IsoError::other(err.to_string())),
		}
	}
	if destination.starts_with(&source) || source.starts_with(&destination) {
		return Err(IsoError::other("source and destination trees overlap"));
	}
	Ok(())
}

/// Creates `merged`'s parent and clears whatever is at `merged` with `remove`,
/// so the walk starts from a fresh destination. `what` names the backend in
/// the error message.
pub fn prepare_destination(
	merged: &Path,
	what: &str,
	remove: impl FnOnce(&Path) -> io::Result<()>,
) -> IsoResult<()> {
	if let Some(parent) = merged.parent() {
		fs::create_dir_all(parent)
			.map_err(|err| IsoError::other(format!("create parent of {}: {err}", merged.display())))?;
	}
	remove(merged).map_err(|err| {
		IsoError::other(format!("unable to clear {} before {what}: {err}", merged.display()))
	})
}

/// Removes the directory tree, file, or symlink at `path`; a missing path is
/// not an error.
pub fn remove_existing(path: &Path) -> io::Result<()> {
	let result = match fs::symlink_metadata(path) {
		Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
		Ok(_) => fs::remove_file(path),
		Err(err) => Err(err),
	};
	match result {
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
		other => other,
	}
}

/// Recreates the symlink `src` at `dst` with the same target. `file_type` is
/// `src`'s own (unfollowed) type; Windows needs it to pick a directory or
/// file link.
pub fn copy_symlink(src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()> {
	let target = fs::read_link(src)
		.map_err(|err| IsoError::other(format!("read_link {}: {err}", src.display())))?;
	#[cfg(unix)]
	let res = {
		let _ = file_type;
		std::os::unix::fs::symlink(target, dst)
	};
	#[cfg(windows)]
	let res = if std::os::windows::fs::FileTypeExt::is_symlink_dir(&file_type) {
		std::os::windows::fs::symlink_dir(target, dst)
	} else {
		std::os::windows::fs::symlink_file(target, dst)
	};
	#[cfg(not(any(unix, windows)))]
	let res: io::Result<()> = {
		let _ = (target, file_type);
		Err(io::Error::new(io::ErrorKind::Unsupported, "symlink copy unsupported on this platform"))
	};
	res.map_err(|err| IsoError::other(format!("symlink {}: {err}", dst.display())))
}

/// Per-entry actions of [`copy_dir_contents`].
pub trait TreeCopy {
	/// Recreates the symlink `src` at `dst`.
	fn symlink(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Copies any entry that is neither a directory nor a symlink.
	fn file(&self, src: &Path, dst: &Path, file_type: FileType) -> IsoResult<()>;
	/// Runs after the directory `dst` has been filled from `src`.
	fn finish_dir(&self, src: &Path, dst: &Path) -> IsoResult<()>;
}

/// Copies the entries of the directory `src` into the existing directory
/// `dst`, recursing into subdirectories. Explicit source-relative entries in
/// `skip` are left out. Symlinks are never followed.
pub fn copy_dir_contents(
	src: &Path,
	dst: &Path,
	skip: &[&OsStr],
	copy: &impl TreeCopy,
) -> IsoResult<()> {
	let skip = skip.iter().map(Path::new).collect();
	let destination =
		same_file::Handle::from_path(dst).map_err(|err| IsoError::other(err.to_string()))?;
	copy_dir_contents_at(src, src, dst, &skip, copy, &destination)
}

fn copy_dir_contents_at(
	root: &Path,
	src: &Path,
	dst: &Path,
	skip: &std::collections::BTreeSet<&Path>,
	copy: &impl TreeCopy,
	destination: &same_file::Handle,
) -> IsoResult<()> {
	record(|stats| stats.traversal_measured = true);
	let started = std::time::Instant::now();
	let mut entries = fs::read_dir(src)
		.map_err(|err| IsoError::other(format!("read_dir {}: {err}", src.display())))?;
	record(|stats| {
		stats.traversal_ms = started
			.elapsed()
			.as_secs_f64()
			.mul_add(1000.0, stats.traversal_ms);
	});
	loop {
		let started = std::time::Instant::now();
		let Some(entry) = entries.next() else {
			record(|stats| {
				stats.traversal_ms = started
					.elapsed()
					.as_secs_f64()
					.mul_add(1000.0, stats.traversal_ms);
			});
			break;
		};
		let entry =
			entry.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", src.display())))?;
		let src_path = entry.path();
		let file_type = entry
			.file_type()
			.map_err(|err| IsoError::other(format!("file_type {}: {err}", src_path.display())))?;
		let excluded = skip.contains(src_path.strip_prefix(root).unwrap())
			|| (file_type.is_dir()
				&& same_file::Handle::from_path(&src_path)
					.map_err(|err| IsoError::other(err.to_string()))?
					== *destination);
		let bytes = if file_type.is_file() {
			entry
				.metadata()
				.map_err(|err| IsoError::other(err.to_string()))?
				.len()
		} else {
			0
		};
		record(|stats| {
			stats.entries_visited += 1;
			stats.traversal_ms = started
				.elapsed()
				.as_secs_f64()
				.mul_add(1000.0, stats.traversal_ms);
		});
		if excluded {
			record(|stats| stats.entries_skipped += 1);
			continue;
		}
		let dst_path = dst.join(entry.file_name());
		let started = std::time::Instant::now();
		if file_type.is_dir() {
			fs::create_dir_all(&dst_path)
				.map_err(|err| IsoError::other(format!("create {}: {err}", dst_path.display())))?;
			record(|stats| {
				stats.directories_created += 1;
				stats.copy_ms = started
					.elapsed()
					.as_secs_f64()
					.mul_add(1000.0, stats.copy_ms);
			});
			copy_dir_contents_at(root, &src_path, &dst_path, skip, copy, destination)?;
			let started = std::time::Instant::now();
			let result = copy.finish_dir(&src_path, &dst_path);
			record(|stats| {
				stats.copy_ms = started
					.elapsed()
					.as_secs_f64()
					.mul_add(1000.0, stats.copy_ms);
			});
			result?;
		} else {
			let result = if file_type.is_symlink() {
				copy.symlink(&src_path, &dst_path, file_type)
			} else {
				copy.file(&src_path, &dst_path, file_type)
			};
			record(|stats| {
				stats.copy_ms = started
					.elapsed()
					.as_secs_f64()
					.mul_add(1000.0, stats.copy_ms);
			});
			result?;
			record(|stats| {
				stats.files_copied += u64::from(file_type.is_file());
				stats.symlinks_copied += u64::from(file_type.is_symlink());
				stats.bytes_copied += bytes;
			});
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::{
		cell::Cell,
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::*;

	struct FailSecondFile(Cell<u32>);

	impl TreeCopy for FailSecondFile {
		fn symlink(&self, _src: &Path, _dst: &Path, _file_type: FileType) -> IsoResult<()> {
			panic!("fixture contains only regular files");
		}

		fn file(&self, src: &Path, dst: &Path, _file_type: FileType) -> IsoResult<()> {
			self.0.set(self.0.get() + 1);
			if self.0.get() == 2 {
				return Err(IsoError::unavailable("injected second-file clone failure"));
			}
			fs::copy(src, dst).map_err(|err| IsoError::other(err.to_string()))?;
			Ok(())
		}

		fn finish_dir(&self, _src: &Path, _dst: &Path) -> IsoResult<()> {
			Ok(())
		}
	}

	#[test]
	fn traversal_skips_destination_identity_even_without_preflight() {
		let source =
			std::env::temp_dir().join(format!("pi-iso-runtime-destination-{}", std::process::id()));
		let destination = source.join("destination");
		fs::create_dir_all(&destination).unwrap();
		fs::write(source.join("payload"), b"payload").unwrap();
		let stats = measure_clone(|| {
			copy_dir_contents(&source, &destination, &[], &FailSecondFile(Cell::new(0)))
		})
		.unwrap();
		assert_eq!(stats.files_copied, 1);
		assert_eq!(stats.entries_skipped, 1);
		assert_eq!(fs::read(destination.join("payload")).unwrap(), b"payload");
		assert!(!destination.join("destination").exists());
		fs::remove_dir_all(source).unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn destination_under_search_only_parent_is_valid() {
		use std::os::unix::fs::PermissionsExt;
		let root = std::env::temp_dir().join(format!("pi-iso-search-only-{}", std::process::id()));
		let source = root.join("source");
		let parent = root.join("parent");
		fs::create_dir_all(&source).unwrap();
		fs::create_dir(&parent).unwrap();
		fs::set_permissions(&parent, fs::Permissions::from_mode(0o311)).unwrap();
		let result = validate_destination(&source, &parent.join("destination"));
		fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
		fs::remove_dir_all(root).unwrap();
		result.unwrap();
	}

	#[test]
	fn partial_clone_failure_retains_elapsed_time_and_completed_copy_counters() {
		static NEXT: AtomicU64 = AtomicU64::new(0);
		let root = std::env::temp_dir().join(format!(
			"pi-iso-partial-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, Ordering::Relaxed)
		));
		let source = root.join("source");
		let destination = root.join("destination");
		fs::create_dir_all(&source).unwrap();
		fs::create_dir(&destination).unwrap();
		fs::write(source.join("a"), b"payload").unwrap();
		fs::write(source.join("b"), b"payload").unwrap();
		let error = measure_clone(|| {
			copy_dir_contents(&source, &destination, &[], &FailSecondFile(Cell::new(0)))
		})
		.unwrap_err();
		assert!(error.is_unavailable());
		assert_eq!(error.message(), "injected second-file clone failure");
		assert!(error.stats.traversal_measured);
		assert_eq!(error.stats.entries_visited, 2);
		assert_eq!(error.stats.files_copied, 1);
		assert_eq!(error.stats.bytes_copied, 7);
		assert!(error.stats.total_ms.is_finite() && error.stats.total_ms >= 0.0);
		assert_eq!(fs::read_dir(&destination).unwrap().count(), 1);
		assert_eq!(fs::read(source.join("a")).unwrap(), b"payload");
		assert_eq!(fs::read(source.join("b")).unwrap(), b"payload");
		// A later attempt must not inherit counters from the failed attempt.
		let next = measure_clone(|| Ok(())).unwrap();
		assert_eq!(next.files_copied, 0);
		assert!(!next.traversal_measured);
		fs::remove_dir_all(root).unwrap();
	}
}
