//! Canonical directory identity and fail-closed path security helpers.

use std::{
	io,
	path::{Component, Path, PathBuf},
};

use napi::{
	JsString,
	bindgen_prelude::{BigInt, Either, Uint8Array},
};
use napi_derive::napi;

/// Result of resolving an existing directory to its stable platform identity.
#[napi(object)]
pub struct NativeCanonicalDirectoryIdentity {
	pub ok:             bool,
	pub platform:       Option<String>,
	pub canonical_path: Option<String>,
	pub code:           Option<String>,
}

/// Result of applying or checking owner-only path security.
#[napi(object)]
pub struct NativeOwnerOnlySecurityResult {
	pub ok:   bool,
	pub code: Option<String>,
}

/// Caller-supplied identity and preauthorized quarantine evidence for exact
/// deletion.

#[napi(object)]
pub struct NativeExactFileIdentity {
	pub dev:             BigInt,
	pub ino:             BigInt,
	pub size:            BigInt,
	pub mtime_ns:        BigInt,
	/// When true, atomically detach a directory rather than deleting a regular
	/// file.
	pub directory:       Option<bool>,
	/// Keep a regular file in quarantine after its identity has been verified
	/// instead of unlinking it. This makes cross-device retirement recoverable.
	pub detach_only:     Option<bool>,
	/// A caller-persisted, single-component no-replace quarantine destination.
	/// Required for every exact deletion so authority survives a post-detach
	/// crash.
	pub quarantine_name: Option<String>,
	/// SHA-256 of regular-file bytes. Required for regular-file deletion and
	/// verified from the detached object before unlinking it.
	pub sha256:          Option<String>,
}

struct ExactFileIdentity {
	dev:             u64,
	ino:             u64,
	size:            u64,
	mtime_ns:        i64,
	directory:       bool,
	detach_only:     bool,
	quarantine_name: Option<String>,
	sha256:          Option<[u8; 32]>,
}
/// Typed result of an identity-bound regular-file deletion or directory detach.
#[napi(object)]
pub struct NativeExactUnlinkResult {
	pub ok:            bool,
	pub code:          Option<String>,
	pub detached_path: Option<String>,
}

impl NativeExactUnlinkResult {
	const fn success() -> Self {
		Self { ok: true, code: None, detached_path: None }
	}

	fn detached(path: String) -> Self {
		Self { ok: true, code: None, detached_path: Some(path) }
	}

	fn detached_failure(code: &str, path: String) -> Self {
		Self { ok: false, code: Some(code.to_owned()), detached_path: Some(path) }
	}

	fn failure(code: &str) -> Self {
		Self { ok: false, code: Some(code.to_owned()), detached_path: None }
	}
}

fn parse_sha256(value: Option<&String>) -> Option<[u8; 32]> {
	let value = value?;
	if value.len() != 64 {
		return None;
	}
	let mut digest = [0u8; 32];
	for (index, byte) in digest.iter_mut().enumerate() {
		let pair = value.get(index * 2..index * 2 + 2)?;
		*byte = u8::from_str_radix(pair, 16).ok()?;
	}
	Some(digest)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
	const INITIAL: [u32; 8] = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
		0x5be0cd19,
	];
	const K: [u32; 64] = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
		0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
		0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
		0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
		0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
		0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
		0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
		0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
		0xc67178f2,
	];
	let bit_length = (bytes.len() as u64).wrapping_mul(8);
	let mut padded = Vec::with_capacity(bytes.len() + 72);
	padded.extend_from_slice(bytes);
	padded.push(0x80);
	while (padded.len() + 8) % 64 != 0 {
		padded.push(0);
	}
	padded.extend_from_slice(&bit_length.to_be_bytes());
	let mut state = INITIAL;
	for block in padded.chunks_exact(64) {
		let mut words = [0u32; 64];
		for (index, chunk) in block.chunks_exact(4).take(16).enumerate() {
			words[index] = u32::from_be_bytes(chunk.try_into().expect("SHA-256 block word"));
		}
		for index in 16..64 {
			let s0 = words[index - 15].rotate_right(7)
				^ words[index - 15].rotate_right(18)
				^ (words[index - 15] >> 3);
			let s1 = words[index - 2].rotate_right(17)
				^ words[index - 2].rotate_right(19)
				^ (words[index - 2] >> 10);
			words[index] = words[index - 16]
				.wrapping_add(s0)
				.wrapping_add(words[index - 7])
				.wrapping_add(s1);
		}
		let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h) =
			(state[0], state[1], state[2], state[3], state[4], state[5], state[6], state[7]);
		for index in 0..64 {
			let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
			let choice = (e & f) ^ ((!e) & g);
			let temp1 = h
				.wrapping_add(s1)
				.wrapping_add(choice)
				.wrapping_add(K[index])
				.wrapping_add(words[index]);
			let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
			let majority = (a & b) ^ (a & c) ^ (b & c);
			let temp2 = s0.wrapping_add(majority);
			h = g;
			g = f;
			f = e;
			e = d.wrapping_add(temp1);
			d = c;
			c = b;
			b = a;
			a = temp1.wrapping_add(temp2);
		}
		state[0] = state[0].wrapping_add(a);
		state[1] = state[1].wrapping_add(b);
		state[2] = state[2].wrapping_add(c);
		state[3] = state[3].wrapping_add(d);
		state[4] = state[4].wrapping_add(e);
		state[5] = state[5].wrapping_add(f);
		state[6] = state[6].wrapping_add(g);
		state[7] = state[7].wrapping_add(h);
	}
	let mut digest = [0u8; 32];
	for (index, word) in state.iter().enumerate() {
		digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
	}
	digest
}

fn exact_file_identity(identity: &NativeExactFileIdentity) -> Option<ExactFileIdentity> {
	let (dev_negative, dev, dev_lossless) = identity.dev.get_u64();
	let (ino_negative, ino, ino_lossless) = identity.ino.get_u64();
	let (size_negative, size, size_lossless) = identity.size.get_u64();
	let (mtime_ns, mtime_lossless) = identity.mtime_ns.get_i64();
	if dev_negative
		|| ino_negative
		|| size_negative
		|| !dev_lossless
		|| !ino_lossless
		|| !size_lossless
		|| !mtime_lossless
	{
		return None;
	}
	let quarantine_name = identity.quarantine_name.as_ref().and_then(|name| {
		let path = Path::new(name);
		match path.components().next() {
			Some(Component::Normal(component)) if path.components().count() == 1 => component
				.to_str()
				.filter(|component| !component.is_empty())
				.map(str::to_owned),
			_ => None,
		}
	});
	let sha256 = if identity.directory.unwrap_or(false) {
		None
	} else {
		Some(parse_sha256(identity.sha256.as_ref())?)
	};

	Some(ExactFileIdentity {
		dev,
		ino,
		size,
		mtime_ns,
		directory: identity.directory.unwrap_or(false),
		detach_only: identity.detach_only.unwrap_or(false),
		quarantine_name,
		sha256,
	})
}
impl NativeCanonicalDirectoryIdentity {
	fn success(platform: &str, canonical_path: String) -> Self {
		Self {
			ok:             true,
			platform:       Some(platform.to_owned()),
			canonical_path: Some(canonical_path),
			code:           None,
		}
	}

	fn failure(code: &str) -> Self {
		Self {
			ok:             false,
			platform:       None,
			canonical_path: None,
			code:           Some(code.to_owned()),
		}
	}
}

impl NativeOwnerOnlySecurityResult {
	const fn success() -> Self {
		Self { ok: true, code: None }
	}

	fn failure(code: &str) -> Self {
		Self { ok: false, code: Some(code.to_owned()) }
	}
}

fn io_code(error: &io::Error) -> &'static str {
	match error.kind() {
		io::ErrorKind::NotFound => "not_found",
		io::ErrorKind::InvalidInput | io::ErrorKind::NotADirectory => "not_directory",
		_ => "io_error",
	}
}

fn security_io_code(error: &io::Error) -> &'static str {
	match error.kind() {
		io::ErrorKind::NotFound => "not_found",
		io::ErrorKind::InvalidInput | io::ErrorKind::NotADirectory => "not_directory",
		_ => "io_error",
	}
}

#[napi]
pub fn canonical_existing_directory_identity(
	path: Either<JsString, Uint8Array>,
) -> NativeCanonicalDirectoryIdentity {
	let path = match path {
		Either::A(path) => match path
			.into_utf8()
			.and_then(|value| value.as_str().map(str::to_owned))
		{
			Ok(path) if !path.contains('\0') => PathBuf::from(path),
			_ => return NativeCanonicalDirectoryIdentity::failure("io_error"),
		},
		Either::B(path) => match path_from_bytes(path.as_ref()) {
			Some(path) => path,
			None => return NativeCanonicalDirectoryIdentity::failure("io_error"),
		},
	};
	platform::canonical_existing_directory_identity(&path)
}

#[napi]
pub fn apply_owner_only_path_security(path: String, kind: String) -> NativeOwnerOnlySecurityResult {
	if path.contains('\0') {
		return NativeOwnerOnlySecurityResult::failure("io_error");
	}
	platform::apply_owner_only_path_security(Path::new(&path), &kind)
}

#[napi]
pub fn verify_owner_only_path_security(
	path: String,
	kind: String,
) -> NativeOwnerOnlySecurityResult {
	if path.contains('\0') {
		return NativeOwnerOnlySecurityResult::failure("io_error");
	}
	platform::verify_owner_only_path_security(Path::new(&path), &kind)
}

/// Delete only the regular file that still has the supplied platform identity.
///
/// This never follows a symlink or reparse point in the target path and reports
/// validation failures as typed results rather than deleting a replacement.
#[napi]
pub fn exact_unlink(path: String, identity: NativeExactFileIdentity) -> NativeExactUnlinkResult {
	if path.contains('\0') {
		return NativeExactUnlinkResult::failure("io_error");
	}
	let Some(identity) = exact_file_identity(&identity) else {
		return NativeExactUnlinkResult::failure("identity_mismatch");
	};
	platform::exact_unlink(Path::new(&path), &identity)
}

/// Restore only the detached object that still has the supplied platform
/// identity. The detached and original paths must retain the same validated
/// parent, and restoration never replaces an existing original path.
#[napi]
pub fn exact_restore(
	detached_path: String,
	original_path: String,
	identity: NativeExactFileIdentity,
) -> NativeExactUnlinkResult {
	if detached_path.contains('\0') || original_path.contains('\0') {
		return NativeExactUnlinkResult::failure("io_error");
	}
	let Some(identity) = exact_file_identity(&identity) else {
		return NativeExactUnlinkResult::failure("identity_mismatch");
	};
	platform::exact_restore(Path::new(&detached_path), Path::new(&original_path), &identity)
}

#[cfg(unix)]
fn path_from_bytes(bytes: &[u8]) -> Option<PathBuf> {
	use std::os::unix::ffi::OsStringExt;

	Some(PathBuf::from(std::ffi::OsString::from_vec(bytes.to_vec())))
}

#[cfg(not(unix))]
fn path_from_bytes(bytes: &[u8]) -> Option<PathBuf> {
	String::from_utf8(bytes.to_vec()).ok().map(PathBuf::from)
}

#[cfg(unix)]
mod platform {
	use std::{
		ffi::CString,
		fs::{self, File},
		io::Read,
		os::{
			fd::{AsRawFd, FromRawFd},
			unix::{
				ffi::OsStrExt,
				fs::{MetadataExt, PermissionsExt},
			},
		},
		path::{Component, Path},
	};

	use super::{
		ExactFileIdentity, NativeCanonicalDirectoryIdentity, NativeExactUnlinkResult,
		NativeOwnerOnlySecurityResult, io_code, security_io_code, sha256,
	};

	pub(super) fn canonical_existing_directory_identity(
		path: &Path,
	) -> NativeCanonicalDirectoryIdentity {
		let canonical = match fs::canonicalize(path) {
			Ok(path) => path,
			Err(error) => return NativeCanonicalDirectoryIdentity::failure(io_code(&error)),
		};
		let metadata = match fs::metadata(&canonical) {
			Ok(metadata) => metadata,
			Err(error) => return NativeCanonicalDirectoryIdentity::failure(io_code(&error)),
		};
		if !metadata.is_dir() {
			return NativeCanonicalDirectoryIdentity::failure("not_directory");
		}
		let Some(canonical_path) = canonical.as_os_str().to_str() else {
			return NativeCanonicalDirectoryIdentity::failure("not_utf8");
		};
		NativeCanonicalDirectoryIdentity::success("posix", canonical_path.to_owned())
	}

	fn security_code(error: &std::io::Error) -> &'static str {
		if error.raw_os_error() == Some(libc::ELOOP) {
			"reparse_point"
		} else {
			security_io_code(error)
		}
	}

	#[cfg(any(
		target_os = "macos",
		target_os = "ios",
		target_os = "freebsd",
		target_os = "openbsd",
		target_os = "netbsd"
	))]
	fn stat_mtime_ns(stat: &libc::stat) -> i128 {
		i128::from(stat.st_mtimespec.tv_sec) * 1_000_000_000 + i128::from(stat.st_mtimespec.tv_nsec)
	}

	#[cfg(not(any(
		target_os = "macos",
		target_os = "ios",
		target_os = "freebsd",
		target_os = "openbsd",
		target_os = "netbsd"
	)))]
	fn stat_mtime_ns(stat: &libc::stat) -> i128 {
		i128::from(stat.st_mtime) * 1_000_000_000 + i128::from(stat.st_mtime_nsec)
	}

	fn checked_file(
		path: &Path,
		kind: &str,
	) -> Result<(File, fs::Metadata), NativeOwnerOnlySecurityResult> {
		if !matches!(kind, "directory" | "file") {
			return Err(NativeOwnerOnlySecurityResult::failure("io_error"));
		}

		let base = if path.is_absolute() { b"/\0" } else { b".\0" };
		let mut fd = unsafe {
			libc::open(base.as_ptr().cast(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
		};
		if fd < 0 {
			return Err(NativeOwnerOnlySecurityResult::failure(security_code(
				&std::io::Error::last_os_error(),
			)));
		}

		let segments: Vec<Vec<u8>> = path
			.components()
			.filter_map(|component| match component {
				Component::Normal(segment) => Some(segment.as_bytes().to_vec()),
				Component::ParentDir => Some(b"..".to_vec()),
				Component::RootDir | Component::CurDir => None,
				Component::Prefix(_) => None,
			})
			.collect();
		for (index, segment) in segments.iter().enumerate() {
			let segment = match CString::new(segment.as_slice()) {
				Ok(segment) => segment,
				Err(_) => {
					unsafe {
						libc::close(fd);
					}
					return Err(NativeOwnerOnlySecurityResult::failure("io_error"));
				},
			};
			let mut named: libc::stat = unsafe { std::mem::zeroed() };
			if unsafe { libc::fstatat(fd, segment.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) }
				!= 0
			{
				let error = std::io::Error::last_os_error();
				unsafe {
					libc::close(fd);
				}
				return Err(NativeOwnerOnlySecurityResult::failure(security_code(&error)));
			}
			if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
				unsafe {
					libc::close(fd);
				}
				return Err(NativeOwnerOnlySecurityResult::failure("reparse_point"));
			}
			let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
			if index + 1 < segments.len() || kind == "directory" {
				flags |= libc::O_DIRECTORY;
			}
			let next_fd = unsafe { libc::openat(fd, segment.as_ptr(), flags) };
			unsafe {
				libc::close(fd);
			}
			if next_fd < 0 {
				return Err(NativeOwnerOnlySecurityResult::failure(security_code(
					&std::io::Error::last_os_error(),
				)));
			}
			fd = next_fd;
		}

		let file = unsafe { File::from_raw_fd(fd) };
		let metadata = file
			.metadata()
			.map_err(|error| NativeOwnerOnlySecurityResult::failure(security_code(&error)))?;
		if (kind == "directory" && !metadata.is_dir()) || (kind == "file" && !metadata.is_file()) {
			return Err(NativeOwnerOnlySecurityResult::failure("not_directory"));
		}
		Ok((file, metadata))
	}

	#[cfg(target_os = "linux")]
	fn clear_extended_acl(file: &File) -> Result<(), NativeOwnerOnlySecurityResult> {
		let name = b"system.posix_acl_access\0";
		let result = unsafe { libc::fremovexattr(file.as_raw_fd(), name.as_ptr().cast()) };
		if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ENODATA) {
			Ok(())
		} else {
			Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"))
		}
	}

	#[cfg(target_os = "linux")]
	fn has_extended_acl(file: &File) -> Result<bool, NativeOwnerOnlySecurityResult> {
		let name = b"system.posix_acl_access\0";
		let result = unsafe {
			libc::fgetxattr(file.as_raw_fd(), name.as_ptr().cast(), std::ptr::null_mut(), 0)
		};
		if result >= 0 {
			Ok(true)
		} else if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENODATA) {
			Ok(false)
		} else {
			Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"))
		}
	}

	#[cfg(target_os = "macos")]
	unsafe extern "C" {
		fn acl_get_fd(fd: libc::c_int) -> *mut libc::c_void;
		fn acl_init(count: libc::c_int) -> *mut libc::c_void;
		fn acl_set_fd(fd: libc::c_int, acl: *mut libc::c_void) -> libc::c_int;
		fn acl_get_entry(
			acl: *mut libc::c_void,
			entry_id: libc::c_int,
			entry: *mut *mut libc::c_void,
		) -> libc::c_int;
		fn acl_free(object: *mut libc::c_void) -> libc::c_int;
	}

	#[cfg(target_os = "macos")]
	fn clear_extended_acl(file: &File) -> Result<(), NativeOwnerOnlySecurityResult> {
		let acl = unsafe { acl_init(1) };
		if acl.is_null() {
			return Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"));
		}
		let result = unsafe { acl_set_fd(file.as_raw_fd(), acl) };
		unsafe { acl_free(acl) };
		if result == 0 {
			Ok(())
		} else {
			Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"))
		}
	}

	#[cfg(target_os = "macos")]
	fn has_extended_acl(file: &File) -> Result<bool, NativeOwnerOnlySecurityResult> {
		let acl = unsafe { acl_get_fd(file.as_raw_fd()) };
		if acl.is_null() {
			return Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"));
		}
		let mut entry = std::ptr::null_mut();
		let result = unsafe { acl_get_entry(acl, 0, &mut entry) };
		unsafe { acl_free(acl) };
		match result {
			0 => Ok(false),
			1 => Ok(true),
			_ => Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable")),
		}
	}

	pub(super) fn apply_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let (file, metadata) = match checked_file(path, kind) {
			Ok(result) => result,
			Err(result) => return result,
		};
		let mode = if metadata.is_dir() { 0o700 } else { 0o600 };
		let mut permissions = metadata.permissions();
		permissions.set_mode(mode);
		match file.set_permissions(permissions) {
			Ok(()) => {
				#[cfg(any(target_os = "linux", target_os = "macos"))]
				if let Err(result) = clear_extended_acl(&file) {
					return result;
				}
				verify_owner_only_path_security(path, kind)
			},
			Err(error) => NativeOwnerOnlySecurityResult::failure(security_code(&error)),
		}
	}

	pub(super) fn verify_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let (file, metadata) = match checked_file(path, kind) {
			Ok(result) => result,
			Err(result) => return result,
		};
		let expected = if metadata.is_dir() { 0o700 } else { 0o600 };
		if metadata.uid() != unsafe { libc::geteuid() }
			|| metadata.permissions().mode() & 0o777 != expected
		{
			return NativeOwnerOnlySecurityResult::failure("acl_verify_failed");
		}
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		match has_extended_acl(&file) {
			Ok(false) => NativeOwnerOnlySecurityResult::success(),
			Ok(true) => NativeOwnerOnlySecurityResult::failure("acl_verify_failed"),
			Err(result) => result,
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}
	#[cfg(target_os = "linux")]
	fn rename_no_replace(
		parent_fd: libc::c_int,
		source: &CString,
		destination: &CString,
	) -> Result<(), &'static str> {
		let result = unsafe {
			libc::syscall(
				libc::SYS_renameat2,
				parent_fd,
				source.as_ptr(),
				parent_fd,
				destination.as_ptr(),
				libc::RENAME_NOREPLACE,
			)
		};
		if result == 0 {
			Ok(())
		} else {
			match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::EEXIST) => Err("quarantine_collision"),
				Some(libc::ENOSYS) | Some(libc::EINVAL) => Err("atomic_unavailable"),
				_ => Err("io_error"),
			}
		}
	}

	#[cfg(target_os = "macos")]
	unsafe extern "C" {
		fn renameatx_np(
			fromfd: libc::c_int,
			from: *const libc::c_char,
			tofd: libc::c_int,
			to: *const libc::c_char,
			flags: u32,
		) -> libc::c_int;
	}

	#[cfg(target_os = "macos")]
	fn rename_no_replace(
		parent_fd: libc::c_int,
		source: &CString,
		destination: &CString,
	) -> Result<(), &'static str> {
		const RENAME_EXCL: u32 = 0x0000_0004;
		if unsafe {
			renameatx_np(parent_fd, source.as_ptr(), parent_fd, destination.as_ptr(), RENAME_EXCL)
		} == 0
		{
			Ok(())
		} else {
			match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::EEXIST) => Err("quarantine_collision"),
				Some(libc::ENOSYS) | Some(libc::EINVAL) => Err("atomic_unavailable"),
				_ => Err("io_error"),
			}
		}
	}

	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	fn rename_no_replace(_: libc::c_int, _: &CString, _: &CString) -> Result<(), &'static str> {
		Err("atomic_unavailable")
	}

	fn digest_openat(parent_fd: libc::c_int, name: &CString) -> Result<[u8; 32], &'static str> {
		let fd = unsafe {
			libc::openat(parent_fd, name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
		};
		if fd < 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		let mut file = unsafe { File::from_raw_fd(fd) };
		let mut bytes = Vec::new();
		file.read_to_end(&mut bytes).map_err(|_| "io_error")?;
		Ok(sha256(&bytes))
	}

	pub(super) fn exact_unlink(
		path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		let base = if path.is_absolute() { b"/\0" } else { b".\0" };
		let mut parent_fd = unsafe {
			libc::open(base.as_ptr().cast(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
		};
		if parent_fd < 0 {
			return NativeExactUnlinkResult::failure(security_code(&std::io::Error::last_os_error()));
		}
		let mut segments = Vec::new();
		for component in path.components() {
			match component {
				Component::Normal(segment) => segments.push(segment.as_bytes().to_vec()),
				Component::RootDir | Component::CurDir => {},
				Component::ParentDir | Component::Prefix(_) => {
					unsafe { libc::close(parent_fd) };
					return NativeExactUnlinkResult::failure("io_error");
				},
			}
		}
		let Some((name_bytes, ancestors)) = segments.split_last() else {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		for segment_bytes in ancestors {
			let Ok(segment) = CString::new(segment_bytes.as_slice()) else {
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::failure("io_error");
			};
			let mut named: libc::stat = unsafe { std::mem::zeroed() };
			if unsafe {
				libc::fstatat(parent_fd, segment.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
			} != 0
			{
				let error = std::io::Error::last_os_error();
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::failure(security_code(&error));
			}
			if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::failure("reparse_point");
			}
			let next_fd = unsafe {
				libc::openat(
					parent_fd,
					segment.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			};
			unsafe { libc::close(parent_fd) };
			if next_fd < 0 {
				return NativeExactUnlinkResult::failure(security_code(
					&std::io::Error::last_os_error(),
				));
			}
			parent_fd = next_fd;
		}
		let Ok(name) = CString::new(name_bytes.as_slice()) else {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		if unsafe { libc::fstatat(parent_fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) }
			!= 0
		{
			let error = std::io::Error::last_os_error();
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure(security_code(&error));
		}
		if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("reparse_point");
		}
		let expected_kind = if identity.directory {
			libc::S_IFDIR
		} else {
			libc::S_IFREG
		};
		if named.st_mode & libc::S_IFMT != expected_kind {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure(if identity.directory {
				"not_directory"
			} else {
				"not_regular_file"
			});
		}
		if named.st_dev as u64 != identity.dev
			|| named.st_ino as u64 != identity.ino
			|| named.st_size as u64 != identity.size
			|| stat_mtime_ns(&named) != i128::from(identity.mtime_ns)
		{
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if !identity.directory
			&& digest_openat(parent_fd, &name).ok().as_ref() != identity.sha256.as_ref()
		{
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}

		let Some(quarantine_name) = identity.quarantine_name.as_deref() else {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("quarantine_destination_required");
		};
		let Ok(quarantine) = CString::new(quarantine_name) else {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		if let Err(code) = rename_no_replace(parent_fd, &name, &quarantine) {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure(code);
		}
		let mut detached: libc::stat = unsafe { std::mem::zeroed() };
		let matches = unsafe {
			libc::fstatat(parent_fd, quarantine.as_ptr(), &mut detached, libc::AT_SYMLINK_NOFOLLOW)
		} == 0 && detached.st_mode & libc::S_IFMT == expected_kind
			&& detached.st_dev as u64 == identity.dev
			&& detached.st_ino as u64 == identity.ino
			&& detached.st_size as u64 == identity.size
			&& stat_mtime_ns(&detached) == i128::from(identity.mtime_ns);
		if !matches {
			// Restoration refuses to clobber a replacement at the original name.
			let restored = rename_no_replace(parent_fd, &quarantine, &name).is_ok();
			let detached_path = path
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.join(quarantine.to_string_lossy().as_ref())
				.to_string_lossy()
				.into_owned();
			unsafe { libc::close(parent_fd) };
			return if restored {
				NativeExactUnlinkResult::failure("identity_mismatch")
			} else {
				NativeExactUnlinkResult::detached_failure("restore_failed", detached_path)
			};
		}
		if !identity.directory
			&& digest_openat(parent_fd, &quarantine).ok().as_ref() != identity.sha256.as_ref()
		{
			// Restoration refuses to clobber a replacement at the original name.
			let restored = rename_no_replace(parent_fd, &quarantine, &name).is_ok();
			let detached_path = path
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.join(quarantine.to_string_lossy().as_ref())
				.to_string_lossy()
				.into_owned();
			unsafe { libc::close(parent_fd) };
			return if restored {
				NativeExactUnlinkResult::failure("identity_mismatch")
			} else {
				NativeExactUnlinkResult::detached_failure("restore_failed", detached_path)
			};
		}
		if identity.directory || identity.detach_only {
			let detached_path = path
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.join(quarantine.to_string_lossy().as_ref());
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::detached(detached_path.to_string_lossy().into_owned());
		}
		let result = if unsafe { libc::unlinkat(parent_fd, quarantine.as_ptr(), 0) } == 0 {
			NativeExactUnlinkResult::success()
		} else {
			let detached_path = path
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.join(quarantine.to_string_lossy().as_ref());
			NativeExactUnlinkResult::detached_failure(
				security_code(&std::io::Error::last_os_error()),
				detached_path.to_string_lossy().into_owned(),
			)
		};

		unsafe { libc::close(parent_fd) };
		result
	}

	fn open_parent_no_follow(
		path: &Path,
	) -> Result<(libc::c_int, CString), NativeExactUnlinkResult> {
		let base = if path.is_absolute() { b"/\0" } else { b".\0" };
		let mut parent_fd = unsafe {
			libc::open(base.as_ptr().cast(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
		};
		if parent_fd < 0 {
			return Err(NativeExactUnlinkResult::failure(security_code(
				&std::io::Error::last_os_error(),
			)));
		}
		let mut segments = Vec::new();
		for component in path.components() {
			match component {
				Component::Normal(segment) => segments.push(segment.as_bytes().to_vec()),
				Component::RootDir | Component::CurDir => {},
				Component::ParentDir | Component::Prefix(_) => {
					unsafe { libc::close(parent_fd) };
					return Err(NativeExactUnlinkResult::failure("io_error"));
				},
			}
		}
		let Some((name_bytes, ancestors)) = segments.split_last() else {
			unsafe { libc::close(parent_fd) };
			return Err(NativeExactUnlinkResult::failure("io_error"));
		};
		for segment_bytes in ancestors {
			let Ok(segment) = CString::new(segment_bytes.as_slice()) else {
				unsafe { libc::close(parent_fd) };
				return Err(NativeExactUnlinkResult::failure("io_error"));
			};
			let mut named: libc::stat = unsafe { std::mem::zeroed() };
			if unsafe {
				libc::fstatat(parent_fd, segment.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
			} != 0
			{
				let error = std::io::Error::last_os_error();
				unsafe { libc::close(parent_fd) };
				return Err(NativeExactUnlinkResult::failure(security_code(&error)));
			}
			if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
				unsafe { libc::close(parent_fd) };
				return Err(NativeExactUnlinkResult::failure("reparse_point"));
			}
			let next_fd = unsafe {
				libc::openat(
					parent_fd,
					segment.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			};
			unsafe { libc::close(parent_fd) };
			if next_fd < 0 {
				return Err(NativeExactUnlinkResult::failure(security_code(
					&std::io::Error::last_os_error(),
				)));
			}
			parent_fd = next_fd;
		}
		let Ok(name) = CString::new(name_bytes.as_slice()) else {
			unsafe { libc::close(parent_fd) };
			return Err(NativeExactUnlinkResult::failure("io_error"));
		};
		Ok((parent_fd, name))
	}

	pub(super) fn exact_restore(
		detached_path: &Path,
		original_path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		if detached_path.parent() != original_path.parent() {
			return NativeExactUnlinkResult::failure("parent_mismatch");
		}
		let (parent_fd, detached_name) = match open_parent_no_follow(detached_path) {
			Ok(value) => value,
			Err(result) => return result,
		};
		let Some(original_name_bytes) = original_path.file_name().map(|name| name.as_bytes()) else {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		let Ok(original_name) = CString::new(original_name_bytes) else {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		let expected_kind = if identity.directory {
			libc::S_IFDIR
		} else {
			libc::S_IFREG
		};
		let mut detached: libc::stat = unsafe { std::mem::zeroed() };
		let matches = unsafe {
			libc::fstatat(parent_fd, detached_name.as_ptr(), &mut detached, libc::AT_SYMLINK_NOFOLLOW)
		} == 0 && detached.st_mode & libc::S_IFMT == expected_kind
			&& detached.st_dev as u64 == identity.dev
			&& detached.st_ino as u64 == identity.ino
			&& detached.st_size as u64 == identity.size
			&& stat_mtime_ns(&detached) == i128::from(identity.mtime_ns)
			&& (identity.directory
				|| digest_openat(parent_fd, &detached_name).ok().as_ref() == identity.sha256.as_ref());
		if !matches {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if let Err(code) = rename_no_replace(parent_fd, &detached_name, &original_name) {
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure(if code == "quarantine_collision" {
				"collision"
			} else {
				code
			});
		}
		let mut restored: libc::stat = unsafe { std::mem::zeroed() };
		let restored_matches = unsafe {
			libc::fstatat(parent_fd, original_name.as_ptr(), &mut restored, libc::AT_SYMLINK_NOFOLLOW)
		} == 0 && restored.st_mode & libc::S_IFMT == expected_kind
			&& restored.st_dev as u64 == identity.dev
			&& restored.st_ino as u64 == identity.ino
			&& restored.st_size as u64 == identity.size
			&& stat_mtime_ns(&restored) == i128::from(identity.mtime_ns)
			&& (identity.directory
				|| digest_openat(parent_fd, &original_name).ok().as_ref() == identity.sha256.as_ref());
		if !restored_matches {
			let restored = rename_no_replace(parent_fd, &original_name, &detached_name).is_ok();
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure(if restored {
				"identity_mismatch"
			} else {
				"restore_failed"
			});
		}
		unsafe { libc::close(parent_fd) };
		NativeExactUnlinkResult::success()
	}
}

#[cfg(windows)]
mod platform {
	use std::{
		ffi::c_void,
		mem::size_of,
		os::windows::ffi::OsStrExt,
		path::Path,
		ptr::{null, null_mut},
	};

	use windows_sys::Win32::{
		Foundation::{
			CloseHandle, ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, GetLastError,
			HANDLE, INVALID_HANDLE_VALUE, LocalFree,
		},
		Security::{
			ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, ACL_SIZE_INFORMATION, AclSizeInformation,
			AddAccessAllowedAceEx,
			Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
			DACL_SECURITY_INFORMATION, EqualSid, GENERIC_ALL, GetAce, GetAclInformation, GetLengthSid,
			GetTokenInformation, InitializeAcl, OWNER_SECURITY_INFORMATION,
			PROTECTED_DACL_SECURITY_INFORMATION, READ_CONTROL, TOKEN_QUERY, TOKEN_USER, WRITE_DAC,
			WRITE_OWNER,
		},
		Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
			FILE_ATTRIBUTE_REPARSE_POINT, FILE_BEGIN, FILE_DISPOSITION_INFO,
			FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
			FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileDispositionInfo,
			GetFileInformationByHandle, GetFinalPathNameByHandleW, OPEN_EXISTING, ReadFile,
			SetFileInformationByHandle, SetFilePointerEx, VOLUME_NAME_GUID,
		},
		System::Threading::{GetCurrentProcess, OpenProcessToken},
	};

	use super::{
		ExactFileIdentity, NativeCanonicalDirectoryIdentity, NativeExactUnlinkResult,
		NativeOwnerOnlySecurityResult, sha256,
	};

	const SECURITY_OWNER_DACL: u32 = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
	const SECURITY_OWNER_DACL_PROTECTED: u32 =
		SECURITY_OWNER_DACL | PROTECTED_DACL_SECURITY_INFORMATION;

	const FILE_RENAME_INFO_CLASS: i32 = 3;

	#[repr(C)]
	struct HandleRenameInformation {
		replace_if_exists: u8,
		root_directory:    HANDLE,
		file_name_length:  u32,
		file_name:         [u16; 1],
	}

	fn wide(path: &Path) -> Vec<u16> {
		path.as_os_str().encode_wide().chain(Some(0)).collect()
	}

	fn is_network_path(path: &Path) -> bool {
		let value = path.as_os_str().to_string_lossy();
		if value.starts_with(r"\\?\UNC\") {
			true
		} else if value.starts_with(r"\\?\") {
			false
		} else {
			value.starts_with(r"\\")
		}
	}

	fn last_error_code() -> &'static str {
		match unsafe { GetLastError() } {
			ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => "not_found",
			_ => "io_error",
		}
	}

	fn open_path(path: &Path, reparse: bool, desired_access: u32) -> Result<HANDLE, &'static str> {
		if is_network_path(path) {
			return Err("network_unsupported");
		}
		let wide = wide(path);
		let flags = FILE_FLAG_BACKUP_SEMANTICS
			| if reparse {
				FILE_FLAG_OPEN_REPARSE_POINT
			} else {
				0
			};
		let handle = unsafe {
			CreateFileW(
				wide.as_ptr(),
				desired_access,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				null(),
				OPEN_EXISTING,
				FILE_ATTRIBUTE_NORMAL | flags,
				0,
			)
		};
		if handle == INVALID_HANDLE_VALUE {
			return Err(last_error_code());
		}
		Ok(handle)
	}

	fn handle_attributes(handle: HANDLE) -> Result<u32, &'static str> {
		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
			return Err(last_error_code());
		}
		Ok(information.dwFileAttributes)
	}

	fn final_path(handle: HANDLE) -> Result<String, &'static str> {
		let mut buffer = vec![0u16; 32_768];
		let length = unsafe {
			GetFinalPathNameByHandleW(
				handle,
				buffer.as_mut_ptr(),
				buffer.len() as u32,
				VOLUME_NAME_GUID,
			)
		};
		if length == 0 {
			// SMB mapped drives can open normally yet reject VOLUME_NAME_GUID with
			// ERROR_PATH_NOT_FOUND. Their final identity cannot be a local volume.
			return Err(match unsafe { GetLastError() } {
				ERROR_PATH_NOT_FOUND => "network_unsupported",
				_ => "identity_unavailable",
			});
		}
		if length as usize >= buffer.len() {
			return Err("identity_unavailable");
		}
		let value =
			String::from_utf16(&buffer[..length as usize]).map_err(|_| "identity_unavailable")?;
		if value.starts_with(r"\\?\UNC\") {
			return Err("network_unsupported");
		}
		if !value.starts_with(r"\\?\Volume{") {
			return Err("identity_unavailable");
		}
		Ok(value)
	}

	pub(super) fn canonical_existing_directory_identity(
		path: &Path,
	) -> NativeCanonicalDirectoryIdentity {
		let handle = match open_path(path, false, FILE_READ_ATTRIBUTES) {
			Ok(handle) => handle,
			Err(code) => return NativeCanonicalDirectoryIdentity::failure(code),
		};
		let attributes = match handle_attributes(handle) {
			Ok(attributes) => attributes,
			Err(code) => {
				unsafe {
					CloseHandle(handle);
				}
				return NativeCanonicalDirectoryIdentity::failure(code);
			},
		};
		if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
			unsafe {
				CloseHandle(handle);
			}
			return NativeCanonicalDirectoryIdentity::failure("not_directory");
		}
		let result = final_path(handle)
			.map(|canonical_path| NativeCanonicalDirectoryIdentity::success("win32", canonical_path))
			.unwrap_or_else(NativeCanonicalDirectoryIdentity::failure);
		unsafe {
			CloseHandle(handle);
		}
		result
	}

	fn open_exact(
		path: &Path,
		kind: &str,
		desired_access: u32,
	) -> Result<HANDLE, NativeOwnerOnlySecurityResult> {
		if !matches!(kind, "directory" | "file") {
			return Err(NativeOwnerOnlySecurityResult::failure("io_error"));
		}
		for ancestor in path.ancestors().skip(1) {
			if ancestor.as_os_str().is_empty() {
				break;
			}
			let handle = open_path(ancestor, true, FILE_READ_ATTRIBUTES)
				.map_err(NativeOwnerOnlySecurityResult::failure)?;
			let attributes = handle_attributes(handle).map_err(NativeOwnerOnlySecurityResult::failure);
			unsafe {
				CloseHandle(handle);
			}
			if attributes? & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return Err(NativeOwnerOnlySecurityResult::failure("reparse_point"));
			}
		}
		let handle =
			open_path(path, true, desired_access).map_err(NativeOwnerOnlySecurityResult::failure)?;
		let attributes = match handle_attributes(handle) {
			Ok(attributes) => attributes,
			Err(code) => {
				unsafe {
					CloseHandle(handle);
				}
				return Err(NativeOwnerOnlySecurityResult::failure(code));
			},
		};
		if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			unsafe {
				CloseHandle(handle);
			}
			return Err(NativeOwnerOnlySecurityResult::failure("reparse_point"));
		}
		if (kind == "directory") != (attributes & FILE_ATTRIBUTE_DIRECTORY != 0) {
			unsafe {
				CloseHandle(handle);
			}
			return Err(NativeOwnerOnlySecurityResult::failure("not_directory"));
		}
		Ok(handle)
	}

	fn handle_identity_matches(
		information: &BY_HANDLE_FILE_INFORMATION,
		identity: &ExactFileIdentity,
	) -> bool {
		let ino =
			(u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
		let size = (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);
		let filetime = (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
			| u64::from(information.ftLastWriteTime.dwLowDateTime);
		let mtime_ns = i128::from(filetime) * 100 - 11_644_473_600_000_000_000i128;
		u64::from(information.dwVolumeSerialNumber) == identity.dev
			&& ino == identity.ino
			&& size == identity.size
			&& mtime_ns == i128::from(identity.mtime_ns)
	}

	fn rename_handle_no_replace(
		handle: HANDLE,
		parent_handle: HANDLE,
		name: &[u16],
	) -> Result<(), &'static str> {
		let allocation_size =
			size_of::<HandleRenameInformation>() - size_of::<u16>() + std::mem::size_of_val(name);
		let mut buffer = vec![0u8; allocation_size];
		let rename = buffer.as_mut_ptr().cast::<HandleRenameInformation>();
		unsafe {
			(*rename).replace_if_exists = 0;
			(*rename).root_directory = parent_handle;
			(*rename).file_name_length = (name.len() * size_of::<u16>()) as u32;
			std::ptr::copy_nonoverlapping(name.as_ptr(), (*rename).file_name.as_mut_ptr(), name.len());
		}
		if unsafe {
			SetFileInformationByHandle(
				handle,
				FILE_RENAME_INFO_CLASS,
				buffer.as_mut_ptr().cast(),
				buffer.len() as u32,
			)
		} != 0
		{
			Ok(())
		} else if unsafe { GetLastError() } == ERROR_FILE_EXISTS {
			Err("quarantine_collision")
		} else {
			Err(last_error_code())
		}
	}

	fn detach_directory(
		path: &Path,
		handle: HANDLE,
		quarantine_name: &str,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		let Some(parent) = path.parent() else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		let parent_handle = match open_exact(parent, "directory", FILE_READ_ATTRIBUTES) {
			Ok(handle) => handle,
			Err(result) => {
				return NativeExactUnlinkResult {
					ok:            false,
					code:          result.code,
					detached_path: None,
				};
			},
		};
		let detached_parent = match final_path(parent_handle) {
			Ok(path) => path,
			Err(code) => {
				unsafe { CloseHandle(parent_handle) };
				return NativeExactUnlinkResult::failure(code);
			},
		};
		let name_wide: Vec<u16> = quarantine_name.encode_utf16().collect();
		let Some(original_name) = path.file_name() else {
			unsafe { CloseHandle(parent_handle) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		let original_name_wide: Vec<u16> = original_name.encode_wide().collect();
		let result = match rename_handle_no_replace(handle, parent_handle, &name_wide) {
			Ok(()) => {
				let detached_path = Path::new(&detached_parent)
					.join(quarantine_name)
					.to_string_lossy()
					.into_owned();
				let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
				let matches = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0
					&& handle_identity_matches(&information, identity)
					&& (identity.directory
						|| digest_handle(handle).ok().as_ref() == identity.sha256.as_ref());
				if matches {
					NativeExactUnlinkResult::detached(detached_path)
				} else if rename_handle_no_replace(handle, parent_handle, &original_name_wide).is_ok() {
					NativeExactUnlinkResult::failure("identity_mismatch")
				} else {
					NativeExactUnlinkResult::detached_failure("restore_failed", detached_path)
				}
			},
			Err("quarantine_collision") => NativeExactUnlinkResult::failure("quarantine_collision"),
			Err(code) => NativeExactUnlinkResult::failure(code),
		};
		unsafe { CloseHandle(parent_handle) };
		result
	}

	fn digest_handle(handle: HANDLE) -> Result<[u8; 32], &'static str> {
		if unsafe { SetFilePointerEx(handle, 0, null_mut(), FILE_BEGIN) } == 0 {
			return Err(last_error_code());
		}
		let mut bytes = Vec::new();
		let mut chunk = [0u8; 64 * 1024];
		loop {
			let mut read = 0u32;
			if unsafe {
				ReadFile(handle, chunk.as_mut_ptr().cast(), chunk.len() as u32, &mut read, null_mut())
			} == 0
			{
				return Err(last_error_code());
			}
			bytes.extend_from_slice(&chunk[..read as usize]);
			if read < chunk.len() as u32 {
				return Ok(sha256(&bytes));
			}
		}
	}

	pub(super) fn exact_unlink(
		path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		let kind = if identity.directory {
			"directory"
		} else {
			"file"
		};
		// DELETE is deliberately requested on the opened final handle: disposition or
		// rename then applies to that object, not to a later pathname replacement.
		let handle = match open_exact(
			path,
			kind,
			FILE_READ_ATTRIBUTES
				| 0x0001_0000
				| if identity.directory {
					0
				} else {
					FILE_READ_DATA
				},
		) {
			Ok(handle) => handle,
			Err(result) => {
				return NativeExactUnlinkResult {
					ok:            false,
					code:          result.code,
					detached_path: None,
				};
			},
		};
		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
			let code = last_error_code();
			unsafe { CloseHandle(handle) };
			return NativeExactUnlinkResult::failure(code);
		}
		if !handle_identity_matches(&information, identity) {
			unsafe { CloseHandle(handle) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if !identity.directory && digest_handle(handle).ok().as_ref() != identity.sha256.as_ref() {
			unsafe { CloseHandle(handle) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if identity.directory || identity.detach_only {
			let Some(quarantine_name) = identity.quarantine_name.as_deref() else {
				unsafe { CloseHandle(handle) };
				return NativeExactUnlinkResult::failure("quarantine_destination_required");
			};
			let result = detach_directory(path, handle, quarantine_name, identity);
			unsafe { CloseHandle(handle) };
			return result;
		}
		let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
		let result = if unsafe {
			SetFileInformationByHandle(
				handle,
				FileDispositionInfo,
				(&raw mut disposition).cast(),
				size_of::<FILE_DISPOSITION_INFO>() as u32,
			)
		} != 0
		{
			NativeExactUnlinkResult::success()
		} else {
			NativeExactUnlinkResult::failure(last_error_code())
		};
		unsafe { CloseHandle(handle) };
		result
	}

	pub(super) fn exact_restore(
		detached_path: &Path,
		original_path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		if detached_path.parent() != original_path.parent() {
			return NativeExactUnlinkResult::failure("parent_mismatch");
		}
		let kind = if identity.directory {
			"directory"
		} else {
			"file"
		};
		let handle = match open_exact(
			detached_path,
			kind,
			FILE_READ_ATTRIBUTES
				| 0x0001_0000
				| if identity.directory {
					0
				} else {
					FILE_READ_DATA
				},
		) {
			Ok(handle) => handle,
			Err(result) => {
				return NativeExactUnlinkResult {
					ok:            false,
					code:          result.code,
					detached_path: None,
				};
			},
		};
		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
			let code = last_error_code();
			unsafe { CloseHandle(handle) };
			return NativeExactUnlinkResult::failure(code);
		}
		if !handle_identity_matches(&information, identity)
			|| (!identity.directory && digest_handle(handle).ok().as_ref() != identity.sha256.as_ref())
		{
			unsafe { CloseHandle(handle) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		let Some(original_name) = original_path.file_name().and_then(|name| name.to_str()) else {
			unsafe { CloseHandle(handle) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		let result = detach_directory(detached_path, handle, original_name, identity);
		unsafe { CloseHandle(handle) };
		match result {
			NativeExactUnlinkResult { ok: true, .. } => NativeExactUnlinkResult::success(),
			NativeExactUnlinkResult { code: Some(code), .. } if code == "quarantine_collision" => {
				NativeExactUnlinkResult::failure("collision")
			},
			result => result,
		}
	}

	unsafe fn current_user_sid() -> Result<Vec<u8>, ()> {
		let mut token = 0;
		if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
			return Err(());
		}
		let mut size = 0;
		unsafe {
			GetTokenInformation(token, 1, null_mut(), 0, &mut size);
		}
		let mut token_user = vec![0u8; size as usize];
		let ok =
			unsafe { GetTokenInformation(token, 1, token_user.as_mut_ptr().cast(), size, &mut size) }
				!= 0;
		unsafe {
			CloseHandle(token);
		}
		if !ok {
			return Err(());
		}
		let user = unsafe { &*token_user.as_ptr().cast::<TOKEN_USER>() };
		let sid_length = unsafe { GetLengthSid(user.User.Sid) } as usize;
		let mut sid = vec![0u8; sid_length];
		unsafe {
			std::ptr::copy_nonoverlapping(user.User.Sid.cast::<u8>(), sid.as_mut_ptr(), sid_length);
		}
		Ok(sid)
	}

	const OBJECT_INHERIT_ACE: u8 = 0x01;
	const CONTAINER_INHERIT_ACE: u8 = 0x02;
	const SE_DACL_PROTECTED: u16 = 0x1000;

	unsafe fn owner_only_dacl(sid: *mut c_void, kind: &str) -> Result<Vec<u8>, ()> {
		let sid_length = unsafe { GetLengthSid(sid) } as usize;
		let size = size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() + sid_length;
		let mut buffer = vec![0u8; size];
		let acl = buffer.as_mut_ptr().cast::<ACL>();
		let ace_flags = if kind == "directory" {
			OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
		} else {
			0
		};
		if unsafe { InitializeAcl(acl, size as u32, ACL_REVISION) } == 0
			|| unsafe { AddAccessAllowedAceEx(acl, ACL_REVISION, ace_flags, GENERIC_ALL, sid) } == 0
		{
			return Err(());
		}
		Ok(buffer)
	}

	pub(super) fn apply_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let handle = match open_exact(path, kind, WRITE_OWNER | WRITE_DAC | READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		let sid = match unsafe { current_user_sid() } {
			Ok(sid) => sid,
			Err(()) => {
				unsafe {
					CloseHandle(handle);
				}
				return NativeOwnerOnlySecurityResult::failure("acl_unavailable");
			},
		};
		let dacl = match unsafe { owner_only_dacl(sid.as_ptr().cast_mut().cast(), kind) } {
			Ok(dacl) => dacl,
			Err(()) => {
				unsafe {
					CloseHandle(handle);
				}
				return NativeOwnerOnlySecurityResult::failure("acl_apply_failed");
			},
		};
		let status = unsafe {
			SetSecurityInfo(
				handle,
				SE_FILE_OBJECT,
				SECURITY_OWNER_DACL_PROTECTED,
				sid.as_ptr().cast_mut().cast(),
				null_mut(),
				dacl.as_ptr().cast(),
				null_mut(),
			)
		};
		unsafe {
			CloseHandle(handle);
		}
		if status != 0 {
			return NativeOwnerOnlySecurityResult::failure("acl_apply_failed");
		}
		verify_owner_only_path_security(path, kind)
	}

	pub(super) fn verify_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let handle = match open_exact(path, kind, READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		let sid = match unsafe { current_user_sid() } {
			Ok(sid) => sid,
			Err(()) => {
				unsafe {
					CloseHandle(handle);
				}
				return NativeOwnerOnlySecurityResult::failure("acl_unavailable");
			},
		};
		let mut owner = null_mut();
		let mut dacl = null_mut();
		let mut descriptor = null_mut();
		let status = unsafe {
			GetSecurityInfo(
				handle,
				SE_FILE_OBJECT,
				SECURITY_OWNER_DACL,
				&mut owner,
				null_mut(),
				&mut dacl,
				null_mut(),
				&mut descriptor,
			)
		};
		unsafe {
			CloseHandle(handle);
		}
		if status != 0 || descriptor.is_null() {
			return NativeOwnerOnlySecurityResult::failure("acl_unavailable");
		}
		let owner_matches = unsafe { EqualSid(owner, sid.as_ptr().cast_mut().cast()) } != 0;
		let mut control = 0u16;
		let mut revision = 0u32;
		let protected_dacl = unsafe {
			windows_sys::Win32::Security::GetSecurityDescriptorControl(
				descriptor,
				&mut control,
				&mut revision,
			)
		} != 0 && control & SE_DACL_PROTECTED != 0;
		let mut acl_info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
		let acl_ok = !dacl.is_null()
			&& unsafe {
				GetAclInformation(
					dacl,
					(&raw mut acl_info).cast(),
					size_of::<ACL_SIZE_INFORMATION>() as u32,
					AclSizeInformation,
				)
			} != 0;
		let expected_flags = if kind == "directory" {
			OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
		} else {
			0
		};
		let exact_owner_ace = if acl_ok && acl_info.AceCount == 1 {
			let mut ace: *mut c_void = null_mut();
			let got_ace = unsafe { GetAce(dacl, 0, &mut ace) } != 0;
			if got_ace && !ace.is_null() {
				let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
				allowed.Header.AceType == 0
					&& allowed.Header.AceFlags == expected_flags
					&& allowed.Mask == GENERIC_ALL
					&& unsafe {
						EqualSid(
							(&raw const allowed.SidStart).cast_mut().cast(),
							sid.as_ptr().cast_mut().cast(),
						)
					} != 0
			} else {
				false
			}
		} else {
			false
		};
		unsafe {
			LocalFree(descriptor);
		}
		if owner_matches && protected_dacl && exact_owner_ace {
			NativeOwnerOnlySecurityResult::success()
		} else {
			NativeOwnerOnlySecurityResult::failure("acl_verify_failed")
		}
	}
}

#[cfg(not(any(unix, windows)))]
mod platform {
	use std::path::Path;

	use super::{
		ExactFileIdentity, NativeCanonicalDirectoryIdentity, NativeExactUnlinkResult,
		NativeOwnerOnlySecurityResult,
	};

	pub(super) fn canonical_existing_directory_identity(
		_: &Path,
	) -> NativeCanonicalDirectoryIdentity {
		NativeCanonicalDirectoryIdentity::failure("identity_unavailable")
	}
	pub(super) fn exact_unlink(_: &Path, _: &ExactFileIdentity) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("identity_unavailable")
	}
	pub(super) fn exact_restore(
		_: &Path,
		_: &Path,
		_: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("identity_unavailable")
	}
	pub(super) fn apply_owner_only_path_security(
		_: &Path,
		_: &str,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}
	pub(super) fn verify_owner_only_path_security(
		_: &Path,
		_: &str,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}
}
