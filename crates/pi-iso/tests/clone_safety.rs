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

#[cfg(target_os = "linux")]
#[test]
fn bind_mount_alias_rejects_overlap() {
	if std::env::var_os("PI_ISO_BIND_CHILD").is_some() {
		let root = PathBuf::from(std::env::var_os("PI_ISO_BIND_ROOT").unwrap());
		let source = root.join("source");
		let alias = root.join("alias");
		assert!(
			std::process::Command::new("mount")
				.args(["--bind"])
				.arg(&source)
				.arg(&alias)
				.status()
				.unwrap()
				.success()
		);
		assert!(pi_iso::validate_destination(&source, &alias.join("new/child")).is_err());
		assert!(
			pi_iso::backend(pi_iso::BackendKind::LinuxReflink)
				.clone_tree(&source, &alias.join("new/child"), &[])
				.is_err()
		);
		assert!(!source.join("new").exists());
		assert_eq!(fs::read(source.join("precious")).unwrap(), b"unchanged");
		return;
	}
	let available = std::process::Command::new("unshare")
		.args(["-rm", "true"])
		.output();
	if !matches!(&available, Ok(output) if output.status.success()) {
		eprintln!(
			"SKIP bind mount: unshare -rm unavailable: {:?}",
			available.map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
		);
		return;
	}
	let fixture = Fixture::new();
	fs::create_dir(fixture.0.join("source")).unwrap();
	fs::create_dir(fixture.0.join("alias")).unwrap();
	fs::write(fixture.0.join("source/precious"), b"unchanged").unwrap();
	assert!(
		std::process::Command::new("unshare")
			.args(["-rm"])
			.arg(std::env::current_exe().unwrap())
			.args(["--exact", "bind_mount_alias_rejects_overlap", "--nocapture"])
			.env("PI_ISO_BIND_CHILD", "1")
			.env("PI_ISO_BIND_ROOT", &fixture.0)
			.status()
			.unwrap()
			.success()
	);
}

#[test]
fn case_alias_rejects_overlap_when_filesystem_supports_it() {
	let fixture = Fixture::new();
	let source = fixture.0.join("MixedCase");
	fs::create_dir(&source).unwrap();
	let alias = fixture.0.join("mixedcase");
	if !alias.exists() {
		eprintln!("SKIP case alias: temporary filesystem is case-sensitive");
		return;
	}
	assert!(pi_iso::validate_destination(&source, &alias.join("new")).is_err());
	assert!(!source.join("new").exists());
}
