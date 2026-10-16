use std::{
	fs,
	path::PathBuf,
	sync::atomic::{AtomicU64, Ordering},
};

struct Fixture(PathBuf);
impl Fixture {
	fn new() -> Self {
		static NEXT: AtomicU64 = AtomicU64::new(0);
		let path = std::env::temp_dir().join(format!(
			"pi-iso-tree-{}-{}",
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
fn native_clone_preserves_files_and_explicitly_excludes_nested_paths() {
	let fixture = Fixture::new();
	let source = fixture.0.join("source");
	let destination = fixture.0.join("destination");
	fs::create_dir_all(source.join("nested/cache")).unwrap();
	fs::write(source.join("target"), b"normal named file").unwrap();
	fs::write(source.join("nested/keep"), b"keep").unwrap();
	fs::write(source.join("nested/cache/output"), b"excluded").unwrap();
	#[cfg(unix)]
	std::os::unix::fs::symlink("nested/keep", source.join("link")).unwrap();
	for kind in pi_iso::clone_candidates(None) {
		let stats = match pi_iso::backend(kind)
			.clone_tree_with_stats(&source, &destination, &[std::ffi::OsStr::new("nested/cache")])
		{
			Ok(stats) => stats,
			Err(error) if error.is_unavailable() => continue,
			Err(error) => panic!("{kind}: {error}"),
		};
		assert_eq!(fs::read(destination.join("target")).unwrap(), b"normal named file");
		assert_eq!(fs::read(destination.join("nested/keep")).unwrap(), b"keep");
		assert!(!destination.join("nested/cache").exists());
		assert!(source.join("nested/cache/output").exists());
		#[cfg(unix)]
		assert_eq!(fs::read_link(destination.join("link")).unwrap(), PathBuf::from("nested/keep"));
		assert!(stats.total_ms >= 0.0);
		if stats.traversal_measured {
			assert_eq!(stats.files_copied, 2);
			assert_eq!(stats.bytes_copied, 21);
			assert_eq!(stats.directories_created, 1);
			assert_eq!(stats.entries_skipped, 1);
			#[cfg(unix)]
			assert_eq!(stats.symlinks_copied, 1);
		}
		fs::write(destination.join("target"), b"changed clone").unwrap();
		assert_eq!(fs::read(source.join("target")).unwrap(), b"normal named file");
		fs::remove_dir_all(&destination).unwrap();
	}
}
