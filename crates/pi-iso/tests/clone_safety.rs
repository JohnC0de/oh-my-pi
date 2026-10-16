use std::{
	fs,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

struct Fixture(PathBuf);
impl Fixture {
	fn new() -> Self {
		static NEXT: AtomicU64 = AtomicU64::new(0);
		let path = std::env::temp_dir().join(format!(
			"pi-iso-safety-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, Ordering::Relaxed)
		));
		fs::create_dir(&path).unwrap();
		Self(path)
	}
}
impl Drop for Fixture {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.0);
	}
}

#[test]
fn overlapping_destinations_preserve_source_and_do_not_create_parents() {
	let fixture = Fixture::new();
	let source = fixture.0.join("source");
	fs::create_dir(&source).unwrap();
	fs::write(source.join("precious"), b"unchanged").unwrap();
	for destination in [source.clone(), source.join("missing/child"), fixture.0.clone()] {
		assert!(pi_iso::validate_destination(&source, &destination).is_err());
		#[cfg(target_os = "linux")]
		assert!(
			pi_iso::backend(pi_iso::BackendKind::LinuxReflink)
				.clone_tree(&source, &destination, &[])
				.is_err()
		);
		assert_eq!(fs::read(source.join("precious")).unwrap(), b"unchanged");
		assert!(!source.join("missing").exists());
	}
}

#[cfg(unix)]
#[test]
fn symlinked_existing_ancestors_and_dotdot_cannot_hide_overlap() {
	let fixture = Fixture::new();
	let source = fixture.0.join("source");
	fs::create_dir_all(source.join("inside")).unwrap();
	fs::write(source.join("precious"), b"unchanged").unwrap();
	let alias = fixture.0.join("alias");
	std::os::unix::fs::symlink(source.join("inside"), &alias).unwrap();
	for destination in [alias.join("new/child"), alias.join("../new"), alias.join("..")] {
		assert!(pi_iso::validate_destination(&source, &destination).is_err());
		#[cfg(target_os = "linux")]
		assert!(
			pi_iso::backend(pi_iso::BackendKind::LinuxReflink)
				.clone_tree(&source, &destination, &[])
				.is_err()
		);
	}
	assert_eq!(fs::read(source.join("precious")).unwrap(), b"unchanged");
	assert!(!source.join("new").exists());
	assert!(!source.join("inside/new").exists());
	assert!(pi_iso::validate_destination(&source, &fixture.0.join("sibling/new")).is_ok());
}

#[test]
fn missing_source_is_not_treated_as_a_safe_clone_root() {
	assert!(
		pi_iso::backend(pi_iso::BackendKind::Rcopy)
			.start(
				Path::new("/nonexistent/pi-iso-source"),
				Path::new("/nonexistent/pi-iso-destination")
			)
			.is_err()
	);
}

#[cfg(target_os = "linux")]
#[test]
fn overlay_auxiliary_overlap_is_rejected_before_any_cleanup() {
	for auxiliary in ["upper", "work"] {
		for nested in [false, true] {
			let fixture = Fixture::new();
			let auxiliary_path = fixture.0.join(auxiliary);
			let source = if nested {
				auxiliary_path.join("source")
			} else {
				auxiliary_path
			};
			fs::create_dir_all(&source).unwrap();
			fs::write(source.join("precious"), b"unchanged").unwrap();
			let other = if auxiliary == "upper" {
				"work"
			} else {
				"upper"
			};
			fs::create_dir(fixture.0.join(other)).unwrap();
			fs::write(fixture.0.join(other).join("keep"), b"also unchanged").unwrap();
			let merged = fixture.0.join("merged");
			fs::create_dir(&merged).unwrap();
			fs::write(merged.join("keep"), b"still unchanged").unwrap();
			let error = pi_iso::backend(pi_iso::BackendKind::Overlayfs)
				.start(&source, &merged)
				.unwrap_err();
			assert!(error.message().contains("overlap"), "{error}");
			assert_eq!(fs::read(source.join("precious")).unwrap(), b"unchanged");
			assert_eq!(fs::read(fixture.0.join(other).join("keep")).unwrap(), b"also unchanged");
			assert_eq!(fs::read(merged.join("keep")).unwrap(), b"still unchanged");
		}
	}
}

#[cfg(target_os = "linux")]
#[test]
fn overlay_auxiliary_symlink_ancestor_cannot_hide_source() {
	let fixture = Fixture::new();
	let source = fixture.0.join("source");
	fs::create_dir_all(source.join("inside")).unwrap();
	fs::write(source.join("precious"), b"unchanged").unwrap();
	let alias = fixture.0.join("alias");
	std::os::unix::fs::symlink(source.join("inside"), &alias).unwrap();
	let base = fixture.0.join("overlay");
	fs::create_dir(&base).unwrap();
	std::os::unix::fs::symlink(alias.join(".."), base.join("upper")).unwrap();
	let error = pi_iso::backend(pi_iso::BackendKind::Overlayfs)
		.start(&source, &base.join("merged"))
		.unwrap_err();
	assert!(error.message().contains("overlap"), "{error}");
	assert_eq!(fs::read(source.join("precious")).unwrap(), b"unchanged");
	assert!(
		fs::symlink_metadata(base.join("upper"))
			.unwrap()
			.file_type()
			.is_symlink()
	);
	assert!(!base.join("work").exists());
	assert!(!base.join("merged").exists());
}

#[test]
fn projfs_overlap_is_rejected_before_platform_probe_or_mutation() {
	let fixture = Fixture::new();
	let source = fixture.0.join("source");
	fs::create_dir(&source).unwrap();
	fs::write(source.join("precious"), b"unchanged").unwrap();
	let mut destinations = vec![source.clone(), source.join("new/child"), fixture.0.clone()];
	#[cfg(unix)]
	{
		let alias = fixture.0.join("alias");
		std::os::unix::fs::symlink(&source, &alias).unwrap();
		destinations.push(alias.join("missing/child"));
	}
	for destination in destinations {
		let error = pi_iso::backend(pi_iso::BackendKind::Projfs)
			.start(&source, &destination)
			.unwrap_err();
		assert!(error.message().contains("overlap"), "{error}");
		assert!(!error.is_unavailable(), "overlap must precede unavailable platform errors");
		assert_eq!(fs::read(source.join("precious")).unwrap(), b"unchanged");
		assert!(!source.join("new").exists());
		assert!(!source.join("missing").exists());
	}
}
