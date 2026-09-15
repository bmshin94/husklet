//! Stopped-process architectural capture for the staged native x86 checkpoint reader.
//!
//! Publication remains behind the native checkpoint eligibility gate.  The transaction here is the
//! complete, fail-closed publication primitive that gate will call once the lifecycle is admitted.
#![allow(dead_code)]

use crate::composition::{CheckpointSink, CompositionError};
use sha2::{Digest as _, Sha256};
use std::io;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(target_os = "linux")]
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", target_arch = "x86_64"))]
use std::time::Duration;
use std::time::Instant;

/// The one place the `native-x86` image format version lives.  Bumping it here
/// is a compile error until every other carrier of the version moves with it:
/// see the `const` block below.
const NATIVE_FORMAT_VERSION: u16 = 2;

const MAGIC: &[u8; 8] = b"HLNXREG\0";
const VERSION: u16 = NATIVE_FORMAT_VERSION;
const ELF_MACHINE_X86_64: u16 = 62;
pub(super) const RECORD_SIZE: usize = 256;
const REGISTER_COUNT: usize = 27;
const REGISTER_OFFSET: usize = 32;
const MEMORY_MAGIC: &[u8; 8] = b"HLNXMEM\0";
const MEMORY_VERSION: u16 = 2;
const MEMORY_HEADER_SIZE: usize = 32;
const MEMORY_ENTRY_SIZE: usize = 96;
const MAX_MAPPINGS: usize = 4096;
const MAX_CAPTURE_BYTES: usize = 1 << 30;
const MAX_PATH_BYTES: usize = 4096;
#[cfg(target_arch = "x86_64")]
const STOP_DEADLINE: Duration = Duration::from_secs(2);
#[cfg(target_os = "linux")]
const ABORT_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) const REGISTER_OBJECT: &str = "native/registers.x86-v2";

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn pin_native_process(pid: libc::pid_t) -> io::Result<OwnedFd> {
    // SAFETY: pidfd_open consumes only scalar arguments and returns a new descriptor or -1; it retains no pointer.
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: the successful syscall returned a new owned descriptor, transferred exactly once here.
        Ok(unsafe { OwnedFd::from_raw_fd(descriptor as libc::c_int) })
    }
}
pub(crate) const MEMORY_OBJECT: &str = "native/memory.x86-v2";
/// Extended processor state -- x87, SSE, AVX and AVX-512 -- as its own object.
/// The XSAVE area is variable length and host dependent, so it does not belong
/// in the fixed-size register record; giving it a manifest slot buys it the same
/// declared size and SHA-256 digest every other object already gets.
pub(crate) const XSTATE_OBJECT: &str = "native/xstate.x86-v2";
const MANIFEST_MAGIC: &[u8; 16] = b"HLNATIVE-X86-V2\0";
const MANIFEST_SIZE: usize = 232;
const MANIFEST_SLOT: usize = 72;

/// Four places used to carry the format version independently -- `VERSION`, the
/// `MANIFEST_MAGIC` text, the `...x86-vN` object-name suffixes, and (a fifth the
/// audit missed) the image envelope's payload version -- and nothing made them
/// move together.  This does.
const _: () = {
    assert!(NATIVE_FORMAT_VERSION > 0 && NATIVE_FORMAT_VERSION < 10);
    assert!(VERSION == NATIVE_FORMAT_VERSION);
    assert!(XSTATE_VERSION == NATIVE_FORMAT_VERSION);
    assert!(MANIFEST_MAGIC[15] == 0);
    assert!(ascii_format_version(MANIFEST_MAGIC[14]) == NATIVE_FORMAT_VERSION);
    assert!(trailing_format_version(REGISTER_OBJECT) == NATIVE_FORMAT_VERSION);
    assert!(trailing_format_version(MEMORY_OBJECT) == NATIVE_FORMAT_VERSION);
    assert!(trailing_format_version(XSTATE_OBJECT) == NATIVE_FORMAT_VERSION);
    assert!(crate::runtime::checkpoint::image_envelope::NATIVE_X86_PAYLOAD_VERSION == NATIVE_FORMAT_VERSION as u32);
    assert!(MANIFEST_SIZE == 16 + 3 * MANIFEST_SLOT);
};

const fn ascii_format_version(digit: u8) -> u16 {
    assert!(digit.is_ascii_digit(), "format version carrier must end in a digit");
    (digit - b'0') as u16
}

const fn trailing_format_version(name: &str) -> u16 {
    let bytes = name.as_bytes();
    ascii_format_version(bytes[bytes.len() - 1])
}

pub(crate) struct NativeSnapshotObjects {
    pub(crate) registers: Vec<u8>,
    pub(crate) memory: Vec<u8>,
    pub(crate) xstate: Vec<u8>,
    pub(crate) manifest: Vec<u8>,
}

#[cfg(target_os = "linux")]
pub(crate) fn capture_stopped_native(
    pid: libc::pid_t,
    deadline: Instant,
) -> Result<NativeSnapshotObjects, CompositionError> {
    // One attachment spans the thread state and the memory image.  Capturing
    // them under two separate attachments detached in between, and detaching a
    // group-stopped tracee makes it briefly runnable while it re-enters group
    // stop -- during which `capture_stopped_memory`'s one-shot "is it stopped"
    // admission fails.  See `capture_thread_and_memory_until`.
    let (thread, memory) = capture_thread_and_memory_until(pid, deadline)
        .and_then(|(thread, image)| {
            let memory = image
                .encode()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("{error:?}")))?;
            Ok((thread, memory))
        })
        .map_err(|error| {
            if error.kind() == io::ErrorKind::TimedOut {
                CompositionError::DeadlineExceeded
            } else {
                CompositionError::RuntimeConstruction
            }
        })?;
    let registers = thread.registers.encode().to_vec();
    let xstate = thread.xstate.encode();
    if Instant::now() >= deadline {
        return Err(CompositionError::DeadlineExceeded);
    }
    let manifest = native_manifest(&registers, &memory, &xstate);
    validate_native_objects(&manifest, |name| match name {
        REGISTER_OBJECT => Some(registers.clone()),
        MEMORY_OBJECT => Some(memory.clone()),
        XSTATE_OBJECT => Some(xstate.clone()),
        _ => None,
    })
    .map_err(|_| CompositionError::RuntimeConstruction)?;
    Ok(NativeSnapshotObjects {
        registers,
        memory,
        xstate,
        manifest,
    })
}

/// Hydrates a freshly launched, group-stopped process from a validated NativeX86V1 image.
///
/// The first milestone deliberately requires the launcher to reproduce the complete VMA layout. It
/// refuses before mutation when ASLR, the executable, loader, root, or mapped file contents differ;
/// remote mmap/open reconstruction is a later widening, never an implicit partial restore.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) struct PreparedNativeRestore {
    pid: libc::pid_t,
    _pidfd: OwnedFd,
    registers: X86RegisterRecord,
    xstate: X86XstateRecord,
    image: NativeMemoryImage,
    guard: TraceGuard,
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn prepare_native_restore(
    pid: libc::pid_t,
    pidfd: OwnedFd,
    registers: &[u8],
    memory: &[u8],
    xstate: &[u8],
    deadline: Instant,
) -> io::Result<PreparedNativeRestore> {
    let registers = X86RegisterRecord::decode(registers)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("invalid register image: {error:?}")))?;
    let image = NativeMemoryImage::decode(memory)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("invalid memory image: {error:?}")))?;
    let xstate = X86XstateRecord::decode(xstate)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("invalid xstate image: {error:?}")))?;
    if pid <= 1 || pid == unsafe { libc::getpid() } || !process_incarnation_matches(pid, pidfd.as_raw_fd())? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "native restore requires another pinned process",
        ));
    }
    check_deadline(deadline)?;
    ptrace(libc::PTRACE_SEIZE, pid, 0, 0)?;
    let mut guard = TraceGuard {
        pid,
        was_group_stopped: false,
        ptrace_stopped: false,
    };
    ptrace(libc::PTRACE_INTERRUPT, pid, 0, 0)?;
    guard.was_group_stopped = wait_for_ptrace_stop_until(pid, deadline)?;
    guard.ptrace_stopped = true;
    if !process_incarnation_matches(pid, pidfd.as_raw_fd())? {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "native restore target incarnation changed",
        ));
    }
    refuse_unrepresentable_threads(pid)?;
    let root = PathBuf::from(format!("/proc/{pid}/root"));
    let current = parse_maps(&std::fs::read(format!("/proc/{pid}/maps"))?, &root, deadline)?;
    let mismatch = current.iter().zip(&image.mappings).position(|(current, captured)| {
        current.start != captured.start
            || current.end != captured.end
            || current.offset != captured.offset
            || current.protection != captured.protection
            || current.device_major != captured.device_major
            || current.device_minor != captured.device_minor
            || current.inode != captured.inode
            || current.kernel_special != captured.kernel_special
            || current.root_relative != captured.root_relative
            || current.file_digest != captured.file_digest
    });
    if current.len() != image.mappings.len() || mismatch.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "fresh process address-space layout differs from NativeX86 image",
        ));
    }
    // Cross-host admission, decided before any mutation.  The local convention
    // and area size are read from the restore target itself, which is the only
    // authority for this kernel and CPU; the enabled XCR0 comes from XGETBV.
    // Every failure is a refusal -- nothing is zero filled, truncated, or
    // re-laid-out component by component to make a foreign area fit.
    check_deadline(deadline)?;
    let local = capture_xstate(pid)?;
    xstate.admits(&local).map_err(|mismatch| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            format!("native xstate host mismatch: {mismatch:?}"),
        )
    })?;

    Ok(PreparedNativeRestore {
        pid,
        _pidfd: pidfd,
        registers,
        xstate,
        image,
        guard,
    })
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn complete_native_restore(prepared: PreparedNativeRestore, deadline: Instant) -> io::Result<()> {
    let PreparedNativeRestore {
        pid,
        _pidfd,
        registers,
        xstate,
        image,
        guard,
    } = prepared;
    if !process_incarnation_matches(pid, _pidfd.as_raw_fd())? {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "native restore target incarnation changed",
        ));
    }
    let process_memory = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("/proc/{pid}/mem"))?;
    for mapping in &image.mappings {
        if mapping.kernel_special {
            continue;
        }
        write_process_mem_exact(&process_memory, mapping.start, &mapping.bytes, deadline)?;
    }

    let mut raw: libc::user_regs_struct = unsafe { std::mem::zeroed() };
    unsafe {
        std::ptr::write_unaligned((&raw mut raw).cast::<[u64; REGISTER_COUNT]>(), registers.registers);
    }
    let mut iov = libc::iovec {
        iov_base: (&raw mut raw).cast(),
        iov_len: std::mem::size_of_val(&raw),
    };
    ptrace(
        libc::PTRACE_SETREGSET,
        pid,
        libc::NT_PRSTATUS as usize,
        (&raw mut iov) as usize,
    )?;
    // Replay the XSAVE area verbatim.  The kernel validates the header it is
    // handed and rejects anything it cannot accept, which keeps this fail-closed.
    let mut area = xstate.area.clone();
    let mut xstate_iov = libc::iovec {
        iov_base: area.as_mut_ptr().cast(),
        iov_len: area.len(),
    };
    ptrace(
        libc::PTRACE_SETREGSET,
        pid,
        NT_X86_XSTATE as usize,
        (&raw mut xstate_iov) as usize,
    )?;
    ptrace(
        libc::PTRACE_SETSIGMASK,
        pid,
        std::mem::size_of_val(&registers.signal_mask),
        (&raw const registers.signal_mask) as usize,
    )?;
    check_deadline(deadline)?;
    drop(guard);
    Ok(())
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn process_incarnation_matches(pid: libc::pid_t, pidfd: std::os::fd::RawFd) -> io::Result<bool> {
    if pidfd < 0 {
        return Ok(false);
    }
    let info = std::fs::read_to_string(format!("/proc/self/fdinfo/{pidfd}"))?;
    let pinned = info
        .lines()
        .find_map(|line| line.strip_prefix("Pid:\t"))
        .and_then(|value| value.trim().parse::<libc::pid_t>().ok());
    Ok(pinned == Some(pid))
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn write_process_mem_exact(memory: &std::fs::File, address: u64, bytes: &[u8], deadline: Instant) -> io::Result<()> {
    let mut written = 0;
    while written < bytes.len() {
        check_deadline(deadline)?;
        let offset = address
            .checked_add(written as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "native mapping address overflow"))?;
        match memory.write_at(&bytes[written..], offset) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "short write restoring native process memory",
                ));
            }
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Manifest slot `index`: a 32-byte object name, an 8-byte declared size and a
/// 32-byte SHA-256 digest, at `16 + index * MANIFEST_SLOT`.
const fn manifest_slot(index: usize) -> (usize, usize, usize) {
    let at = 16 + index * MANIFEST_SLOT;
    (at, at + 32, at + 40)
}

const NATIVE_OBJECTS: [&str; 3] = [REGISTER_OBJECT, MEMORY_OBJECT, XSTATE_OBJECT];

fn native_manifest(registers: &[u8], memory: &[u8], xstate: &[u8]) -> Vec<u8> {
    let mut out = vec![0; MANIFEST_SIZE];
    out[..16].copy_from_slice(MANIFEST_MAGIC);
    for (index, bytes) in [registers, memory, xstate].into_iter().enumerate() {
        let (name_at, size_at, digest_at) = manifest_slot(index);
        out[name_at..name_at + 32].copy_from_slice(&object_name(NATIVE_OBJECTS[index]));
        out[size_at..size_at + 8].copy_from_slice(&(bytes.len() as u64).to_le_bytes());
        out[digest_at..digest_at + 32].copy_from_slice(&Sha256::digest(bytes));
    }
    out
}

fn object_name(name: &str) -> [u8; 32] {
    let mut field = [0; 32];
    field[..name.len()].copy_from_slice(name.as_bytes());
    field
}

pub(crate) fn validate_native_objects(
    manifest: &[u8],
    object: impl Fn(&str) -> Option<Vec<u8>>,
) -> Result<(), InvalidNativeImage> {
    if manifest.len() != MANIFEST_SIZE || &manifest[..16] != MANIFEST_MAGIC {
        return Err(InvalidNativeImage::Manifest);
    }
    let mut objects = Vec::with_capacity(NATIVE_OBJECTS.len());
    for (index, name) in NATIVE_OBJECTS.into_iter().enumerate() {
        let (name_at, _, _) = manifest_slot(index);
        if manifest[name_at..name_at + 32] != object_name(name) {
            return Err(InvalidNativeImage::Manifest);
        }
        objects.push(object(name).ok_or(InvalidNativeImage::Missing)?);
    }
    for (index, bytes) in objects.iter().enumerate() {
        let (_, size_at, digest_at) = manifest_slot(index);
        let size = u64::from_le_bytes(manifest[size_at..size_at + 8].try_into().expect("manifest field"));
        if size != bytes.len() as u64 || manifest[digest_at..digest_at + 32] != Sha256::digest(bytes)[..] {
            return Err(InvalidNativeImage::Digest);
        }
    }
    X86RegisterRecord::decode(&objects[0]).map_err(|_| InvalidNativeImage::Registers)?;
    NativeMemoryImage::decode(&objects[1]).map_err(|_| InvalidNativeImage::Memory)?;
    X86XstateRecord::decode(&objects[2]).map_err(|_| InvalidNativeImage::Xstate)?;
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum InvalidNativeImage {
    Manifest,
    Missing,
    Digest,
    Registers,
    Memory,
    Xstate,
}

/// Atomically stages a complete stopped-process image.  `commit_until` is the only publication
/// point; every earlier failure best-effort aborts the owned transaction before returning.
#[cfg(target_os = "linux")]
pub(super) fn publish_stopped_native(
    sink: &dyn CheckpointSink,
    pid: libc::pid_t,
    deadline: Instant,
) -> Result<(), CompositionError> {
    struct Thaw(libc::pid_t);
    impl Drop for Thaw {
        fn drop(&mut self) {
            unsafe {
                libc::kill(self.0, libc::SIGCONT);
            }
        }
    }
    let _thaw = Thaw(pid);
    if Instant::now() >= deadline {
        return Err(CompositionError::DeadlineExceeded);
    }
    let transaction = sink.begin_until(deadline)?;
    let result = (|| {
        let image = capture_stopped_native(pid, deadline)?;
        sink.put_until(transaction, REGISTER_OBJECT, &image.registers, deadline)?;
        sink.put_until(transaction, MEMORY_OBJECT, &image.memory, deadline)?;
        sink.put_until(transaction, XSTATE_OBJECT, &image.xstate, deadline)?;
        sink.put_until(
            transaction,
            crate::runtime::checkpoint::image_envelope::OBJECT,
            &crate::runtime::checkpoint::image_envelope::Reader::NativeX86.encode(),
            deadline,
        )?;
        sink.commit_until(transaction, &image.manifest, deadline)
    })();
    if result.is_err() {
        // Publication's deadline may itself be the reason for failure. Cleanup owns a separate,
        // short budget so a real transactional sink can release staging without becoming unbounded.
        let cleanup_deadline = Instant::now() + ABORT_CLEANUP_TIMEOUT;
        let _ = sink.abort_until(transaction, cleanup_deadline);
    }
    result
}

/// Canonical `native-x86-v1` architectural state. Register order is Linux x86-64
/// `user_regs_struct`: r15..gs, exactly as returned by `NT_PRSTATUS`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct X86RegisterRecord {
    pub(super) signal_mask: u64,
    pub(super) registers: [u64; REGISTER_COUNT],
}

const XSTATE_MAGIC: &[u8; 8] = b"HLNXXST\0";
const XSTATE_VERSION: u16 = NATIVE_FORMAT_VERSION;
const XSTATE_HEADER_SIZE: usize = 32;
/// 512-byte FXSAVE legacy area plus the 64-byte XSAVE header.
const XSTATE_MIN_AREA: usize = 576;
/// Only an upper bound for discovery -- never a declared layout size.  The real
/// size comes from `CPUID.(EAX=0Dh,ECX=0)` by way of the regset's reported length.
const XSTATE_MAX_AREA: usize = 1 << 16;
const XSTATE_BV_AT: usize = 512;
const XSTATE_XCOMP_BV_AT: usize = 520;
const XSTATE_HEADER_RESERVED_AT: usize = 528;
/// `XCOMP_BV` bit 63: the area is in the compacted (`XSAVEC`) layout rather than
/// the standard one.  Linux's ptrace uabi format is the standard one, so this is
/// recorded and compared rather than assumed.
const XSTATE_COMPACTED_BIT: u64 = 1 << 63;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const NT_X86_XSTATE: libc::c_uint = 0x202;

/// Canonical `native-x86-v2` extended processor state: the XSAVE area exactly as
/// `NT_X86_XSTATE` delivered it, plus the capturing host's effective `XCR0`.
///
/// `NT_PRFPREG` is deliberately **not** used: it yields only the 512-byte FXSAVE
/// legacy area and silently drops every YMM upper half and all AVX-512 state.
///
/// The area is stored and replayed byte for byte.  In particular `XSTATE_BV` and
/// `XCOMP_BV` are never rewritten: writing back a header with a component's bit
/// cleared does not preserve that component, it asks the kernel to restore the
/// component's *init* value, so a capture that "cleans" bits it believes unused
/// actively destroys state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct X86XstateRecord {
    /// `XCR0` as enabled on the capturing host, for cross-host admission.
    pub(super) xcr0: u64,
    /// The uabi XSAVE area: legacy 0..512 (x87, MXCSR at 24, `MXCSR_MASK` at 28,
    /// XMM0-15 at 160), XSAVE header 512..576, extended components beyond.
    pub(super) area: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InvalidXstateRecord {
    Size,
    Magic,
    Version,
    Architecture,
    DeclaredSize,
    Reserved,
    AreaSize,
    HeaderReserved,
    Components,
}

/// Why a captured XSAVE area cannot be replayed on *this* host.  Every arm is a
/// refusal: the area is never zero filled, truncated, or re-laid-out component
/// by component to make it fit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum XstateHostMismatch {
    /// The restoring host does not enable every component the image actually set.
    Features,
    /// Standard versus compacted (`XSAVEC`) layout convention differs.
    Layout,
    /// The local uabi area is a different size, so the component offsets differ
    /// and `PTRACE_SETREGSET` would reject the write anyway.
    AreaSize,
}

impl X86XstateRecord {
    fn header_word(&self, at: usize) -> u64 {
        u64::from_le_bytes(self.area[at..at + 8].try_into().expect("xsave header word"))
    }

    /// Components carrying non-init values in this image.
    pub(super) fn xstate_bv(&self) -> u64 {
        self.header_word(XSTATE_BV_AT)
    }

    pub(super) fn xcomp_bv(&self) -> u64 {
        self.header_word(XSTATE_XCOMP_BV_AT)
    }

    pub(super) fn compacted(&self) -> bool {
        self.xcomp_bv() & XSTATE_COMPACTED_BIT != 0
    }

    /// Fail closed unless this host can replay the image exactly as captured.
    pub(super) fn admits(&self, local: &Self) -> Result<(), XstateHostMismatch> {
        if self.xstate_bv() & !local.xcr0 != 0 {
            return Err(XstateHostMismatch::Features);
        }
        if self.compacted() != local.compacted() {
            return Err(XstateHostMismatch::Layout);
        }
        if self.area.len() != local.area.len() {
            return Err(XstateHostMismatch::AreaSize);
        }
        Ok(())
    }

    pub(super) fn encode(&self) -> Vec<u8> {
        let total = XSTATE_HEADER_SIZE + self.area.len();
        let mut bytes = vec![0_u8; total];
        bytes[..8].copy_from_slice(XSTATE_MAGIC);
        bytes[8..10].copy_from_slice(&XSTATE_VERSION.to_le_bytes());
        bytes[10..12].copy_from_slice(&ELF_MACHINE_X86_64.to_le_bytes());
        bytes[12..16].copy_from_slice(&(total as u32).to_le_bytes());
        bytes[16..24].copy_from_slice(&self.xcr0.to_le_bytes());
        bytes[XSTATE_HEADER_SIZE..].copy_from_slice(&self.area);
        bytes
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<Self, InvalidXstateRecord> {
        if bytes.len() < XSTATE_HEADER_SIZE + XSTATE_MIN_AREA || bytes.len() > XSTATE_HEADER_SIZE + XSTATE_MAX_AREA {
            return Err(InvalidXstateRecord::Size);
        }
        if &bytes[..8] != XSTATE_MAGIC {
            return Err(InvalidXstateRecord::Magic);
        }
        if u16::from_le_bytes(bytes[8..10].try_into().expect("fixed field")) != XSTATE_VERSION {
            return Err(InvalidXstateRecord::Version);
        }
        if u16::from_le_bytes(bytes[10..12].try_into().expect("fixed field")) != ELF_MACHINE_X86_64 {
            return Err(InvalidXstateRecord::Architecture);
        }
        if u32::from_le_bytes(bytes[12..16].try_into().expect("fixed field")) as usize != bytes.len() {
            return Err(InvalidXstateRecord::DeclaredSize);
        }
        if bytes[24..XSTATE_HEADER_SIZE].iter().any(|byte| *byte != 0) {
            return Err(InvalidXstateRecord::Reserved);
        }
        let record = Self {
            xcr0: u64::from_le_bytes(bytes[16..24].try_into().expect("fixed field")),
            area: bytes[XSTATE_HEADER_SIZE..].to_vec(),
        };
        if record.area.len() < XSTATE_MIN_AREA {
            return Err(InvalidXstateRecord::AreaSize);
        }
        if record.area[XSTATE_HEADER_RESERVED_AT..XSTATE_MIN_AREA]
            .iter()
            .any(|byte| *byte != 0)
        {
            return Err(InvalidXstateRecord::HeaderReserved);
        }
        if record.xstate_bv() & !record.xcr0 != 0 {
            return Err(InvalidXstateRecord::Components);
        }
        Ok(record)
    }
}

/// `XCR0` as the OS has it enabled, which is what decides the uabi XSAVE layout.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn host_xcr0() -> Option<u64> {
    #[target_feature(enable = "xsave")]
    fn read() -> u64 {
        // SAFETY: the enclosing `#[target_feature(enable = "xsave")]` is only
        // entered after `xsave` was detected, which is this intrinsic's contract.
        unsafe { core::arch::x86_64::_xgetbv(0) }
    }
    // SAFETY: `xsave` was detected, so CR4.OSXSAVE is set and `XGETBV` with
    // ECX=0 is available to user mode on this host.
    std::arch::is_x86_feature_detected!("xsave").then(|| unsafe { read() })
}

/// One canonical Linux VMA. File mappings name immutable input below the
/// process root; anonymous private mappings instead own `bytes` exactly.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct NativeMapping {
    pub(super) start: u64,
    pub(super) end: u64,
    pub(super) offset: u64,
    pub(super) protection: u8,
    pub(super) device_major: u32,
    pub(super) device_minor: u32,
    pub(super) inode: u64,
    pub(super) kernel_special: bool,
    pub(super) root_relative: Option<Vec<u8>>,
    pub(super) file_digest: Option<[u8; 32]>,
    pub(super) bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct NativeMemoryImage {
    pub(super) mappings: Vec<NativeMapping>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InvalidMemoryImage {
    Size,
    Magic,
    Version,
    Reserved,
    Count,
    Overflow,
    Order,
    Protection,
    Kind,
    Path,
    Payload,
}

impl NativeMemoryImage {
    pub(super) fn encode(&self) -> Result<Vec<u8>, InvalidMemoryImage> {
        if self.mappings.len() > MAX_MAPPINGS {
            return Err(InvalidMemoryImage::Count);
        }
        validate_mappings(&self.mappings)?;
        let variable = self.mappings.iter().try_fold(0usize, |total, mapping| {
            total
                .checked_add(mapping.root_relative.as_ref().map_or(0, Vec::len))
                .and_then(|n| n.checked_add(mapping.bytes.len()))
                .ok_or(InvalidMemoryImage::Overflow)
        })?;
        let fixed = self
            .mappings
            .len()
            .checked_mul(MEMORY_ENTRY_SIZE)
            .and_then(|n| n.checked_add(MEMORY_HEADER_SIZE))
            .ok_or(InvalidMemoryImage::Overflow)?;
        let total = fixed.checked_add(variable).ok_or(InvalidMemoryImage::Overflow)?;
        if variable > MAX_CAPTURE_BYTES || total > u32::MAX as usize {
            return Err(InvalidMemoryImage::Overflow);
        }
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(MEMORY_MAGIC);
        out.extend_from_slice(&MEMORY_VERSION.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes());
        out.extend_from_slice(&(self.mappings.len() as u32).to_le_bytes());
        out.extend_from_slice(&(total as u64).to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        for mapping in &self.mappings {
            let path_len = mapping.root_relative.as_ref().map_or(0, Vec::len);
            out.extend_from_slice(&mapping.start.to_le_bytes());
            out.extend_from_slice(&mapping.end.to_le_bytes());
            out.extend_from_slice(&mapping.offset.to_le_bytes());
            out.extend_from_slice(&mapping.inode.to_le_bytes());
            out.extend_from_slice(&mapping.device_major.to_le_bytes());
            out.extend_from_slice(&mapping.device_minor.to_le_bytes());
            out.push(mapping.protection);
            out.push(if mapping.kernel_special {
                2
            } else {
                u8::from(mapping.root_relative.is_some())
            });
            out.extend_from_slice(&[0; 6]);
            out.extend_from_slice(&(path_len as u32).to_le_bytes());
            out.extend_from_slice(&(mapping.bytes.len() as u64).to_le_bytes());
            out.extend_from_slice(&[0; 4]);
            out.extend_from_slice(mapping.file_digest.as_ref().unwrap_or(&[0; 32]));
        }
        for mapping in &self.mappings {
            if let Some(path) = &mapping.root_relative {
                out.extend_from_slice(path);
            }
            out.extend_from_slice(&mapping.bytes);
        }
        Ok(out)
    }

    pub(super) fn decode(input: &[u8]) -> Result<Self, InvalidMemoryImage> {
        if input.len() < MEMORY_HEADER_SIZE {
            return Err(InvalidMemoryImage::Size);
        }
        if &input[..8] != MEMORY_MAGIC {
            return Err(InvalidMemoryImage::Magic);
        }
        if le_u16(input, 8)? != MEMORY_VERSION {
            return Err(InvalidMemoryImage::Version);
        }
        if le_u16(input, 10)? != 0 || input[24..32].iter().any(|byte| *byte != 0) {
            return Err(InvalidMemoryImage::Reserved);
        }
        let count = usize::try_from(le_u32(input, 12)?).map_err(|_| InvalidMemoryImage::Count)?;
        if count > MAX_MAPPINGS {
            return Err(InvalidMemoryImage::Count);
        }
        let declared = usize::try_from(le_u64(input, 16)?).map_err(|_| InvalidMemoryImage::Overflow)?;
        if declared != input.len() {
            return Err(InvalidMemoryImage::Size);
        }
        let fixed = count
            .checked_mul(MEMORY_ENTRY_SIZE)
            .and_then(|n| n.checked_add(MEMORY_HEADER_SIZE))
            .ok_or(InvalidMemoryImage::Overflow)?;
        if fixed > input.len() {
            return Err(InvalidMemoryImage::Size);
        }
        let mut cursor = fixed;
        let mut mappings = Vec::with_capacity(count);
        for index in 0..count {
            let at = MEMORY_HEADER_SIZE + index * MEMORY_ENTRY_SIZE;
            if input[at + 42..at + 48]
                .iter()
                .chain(&input[at + 60..at + 64])
                .any(|byte| *byte != 0)
            {
                return Err(InvalidMemoryImage::Reserved);
            }
            let kind = input[at + 41];
            if kind > 2 {
                return Err(InvalidMemoryImage::Kind);
            }
            let path_len = usize::try_from(le_u32(input, at + 48)?).map_err(|_| InvalidMemoryImage::Overflow)?;
            let byte_len = usize::try_from(le_u64(input, at + 52)?).map_err(|_| InvalidMemoryImage::Overflow)?;
            let next = cursor
                .checked_add(path_len)
                .and_then(|n| n.checked_add(byte_len))
                .ok_or(InvalidMemoryImage::Overflow)?;
            if next > input.len() {
                return Err(InvalidMemoryImage::Size);
            }
            let root_relative = (kind == 1).then(|| input[cursor..cursor + path_len].to_vec());
            if kind != 1 && path_len != 0 {
                return Err(InvalidMemoryImage::Kind);
            }
            cursor += path_len;
            let bytes = input[cursor..cursor + byte_len].to_vec();
            cursor += byte_len;
            mappings.push(NativeMapping {
                start: le_u64(input, at)?,
                end: le_u64(input, at + 8)?,
                offset: le_u64(input, at + 16)?,
                inode: le_u64(input, at + 24)?,
                device_major: le_u32(input, at + 32)?,
                device_minor: le_u32(input, at + 36)?,
                protection: input[at + 40],
                kernel_special: kind == 2,
                root_relative,
                file_digest: (kind == 1).then(|| input[at + 64..at + 96].try_into().expect("digest field")),
                bytes,
            });
        }
        if cursor != input.len() {
            return Err(InvalidMemoryImage::Payload);
        }
        validate_mappings(&mappings)?;
        Ok(Self { mappings })
    }
}

fn validate_mappings(mappings: &[NativeMapping]) -> Result<(), InvalidMemoryImage> {
    let mut previous_end = 0;
    let mut copied = 0usize;
    for mapping in mappings {
        let length = mapping
            .end
            .checked_sub(mapping.start)
            .ok_or(InvalidMemoryImage::Order)?;
        if length == 0 || mapping.start < previous_end {
            return Err(InvalidMemoryImage::Order);
        }
        previous_end = mapping.end;
        if mapping.protection & !7 != 0 {
            return Err(InvalidMemoryImage::Protection);
        }
        if mapping.kernel_special {
            if mapping.root_relative.is_some()
                || !mapping.bytes.is_empty()
                || mapping.offset != 0
                || mapping.inode != 0
                || mapping.device_major != 0
                || mapping.device_minor != 0
                || mapping.file_digest.is_some()
            {
                return Err(InvalidMemoryImage::Kind);
            }
            continue;
        }
        match &mapping.root_relative {
            Some(path) => {
                if !canonical_relative(path)
                    || path.len() > MAX_PATH_BYTES
                    || path.contains(&0)
                    || mapping.file_digest.is_none()
                {
                    return Err(InvalidMemoryImage::Path);
                }
            }
            None => {
                if mapping.offset != 0
                    || mapping.inode != 0
                    || mapping.device_major != 0
                    || mapping.device_minor != 0
                    || mapping.file_digest.is_some()
                {
                    return Err(InvalidMemoryImage::Kind);
                }
            }
        }
        if mapping.bytes.len() as u64 != length {
            return Err(InvalidMemoryImage::Payload);
        }
        copied = copied
            .checked_add(mapping.bytes.len())
            .ok_or(InvalidMemoryImage::Overflow)?;
    }
    if copied > MAX_CAPTURE_BYTES {
        return Err(InvalidMemoryImage::Overflow);
    }
    Ok(())
}

fn canonical_relative(path: &[u8]) -> bool {
    !path.is_empty()
        && path[0] != b'/'
        && path
            .split(|byte| *byte == b'/')
            .all(|part| !part.is_empty() && part != b"." && part != b"..")
}

fn le_u16(bytes: &[u8], at: usize) -> Result<u16, InvalidMemoryImage> {
    Ok(u16::from_le_bytes(
        bytes
            .get(at..at + 2)
            .ok_or(InvalidMemoryImage::Size)?
            .try_into()
            .expect("field"),
    ))
}
fn le_u32(bytes: &[u8], at: usize) -> Result<u32, InvalidMemoryImage> {
    Ok(u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .ok_or(InvalidMemoryImage::Size)?
            .try_into()
            .expect("field"),
    ))
}
fn le_u64(bytes: &[u8], at: usize) -> Result<u64, InvalidMemoryImage> {
    Ok(u64::from_le_bytes(
        bytes
            .get(at..at + 8)
            .ok_or(InvalidMemoryImage::Size)?
            .try_into()
            .expect("field"),
    ))
}

/// Captures the stable VMA view of an already-admitted, already-stopped process.
/// It neither attaches nor resumes the process, so stop and cleanup ownership stay
/// with the coordinator that admitted it.
#[cfg(target_os = "linux")]
pub(super) fn capture_stopped_memory(pid: libc::pid_t, deadline: Instant) -> io::Result<NativeMemoryImage> {
    if pid <= 1 || pid == unsafe { libc::getpid() } || !process_is_stopped(pid)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "memory capture requires another stopped process",
        ));
    }
    check_deadline(deadline)?;
    let maps_path = format!("/proc/{pid}/maps");
    let before = std::fs::read(&maps_path)?;
    if before.len() > MAX_MAPPINGS * MAX_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process map table exceeds bound",
        ));
    }
    let root = PathBuf::from(format!("/proc/{pid}/root"));
    let specifications = parse_maps(&before, &root, deadline)?;
    let memory = std::fs::File::open(format!("/proc/{pid}/mem"))?;
    let mut copied = 0usize;
    let mut mappings = Vec::with_capacity(specifications.len());
    for mut mapping in specifications {
        check_deadline(deadline)?;
        if !mapping.kernel_special {
            let length = usize::try_from(mapping.end - mapping.start)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "mapping length exceeds host"))?;
            copied = copied
                .checked_add(length)
                .filter(|total| *total <= MAX_CAPTURE_BYTES)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "native memory exceeds capture bound"))?;
            mapping.bytes = read_process_mem_exact(&memory, mapping.start, length, deadline)?;
        }
        mappings.push(mapping);
    }
    check_deadline(deadline)?;
    revalidate_file_mappings(&mappings, &root, deadline)?;
    ensure_same_maps(&before, &std::fs::read(maps_path)?)?;
    validate_mappings(&mappings)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("invalid VMA table: {error:?}")))?;
    Ok(NativeMemoryImage { mappings })
}

#[cfg(target_os = "linux")]
fn revalidate_file_mappings(mappings: &[NativeMapping], root: &Path, deadline: Instant) -> io::Result<()> {
    for mapping in mappings {
        let (Some(path), Some(expected)) = (&mapping.root_relative, mapping.file_digest) else {
            continue;
        };
        check_deadline(deadline)?;
        let path = std::str::from_utf8(path)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 mapping path"))?;
        let file = std::fs::File::open(root.join(path))?;
        let metadata = file.metadata()?;
        if metadata.ino() != mapping.inode
            || libc::major(metadata.dev()) as u32 != mapping.device_major
            || libc::minor(metadata.dev()) as u32 != mapping.device_minor
            || hash_file_range(&file, mapping.offset, mapping.end - mapping.start, deadline)? != expected
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "file mapping content identity changed",
            ));
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn capture_stopped_memory(
    _pid: libc::pid_t,
    _deadline: std::time::Instant,
) -> io::Result<NativeMemoryImage> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "native memory capture requires Linux",
    ))
}

#[cfg(target_os = "linux")]
fn parse_maps(input: &[u8], root: &Path, deadline: Instant) -> io::Result<Vec<NativeMapping>> {
    let text =
        std::str::from_utf8(input).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 process maps"))?;
    let mut mappings = Vec::new();
    for line in text.lines() {
        if mappings.len() == MAX_MAPPINGS {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "too many process mappings"));
        }
        // Linux escapes whitespace in map pathnames, so tokenizing all fields is
        // lossless and avoids `splitn` consuming its limit on alignment spaces.
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "malformed process map"));
        }
        let (start, end) = fields[0]
            .split_once('-')
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed mapping range"))?;
        let start = u64::from_str_radix(start, 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad mapping start"))?;
        let end =
            u64::from_str_radix(end, 16).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad mapping end"))?;
        let perms = fields[1].as_bytes();
        if perms.len() != 4 || !matches!(perms[3], b'p') {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "shared or malformed mapping is not capturable",
            ));
        }
        let protection =
            u8::from(perms[0] == b'r') | (u8::from(perms[1] == b'w') << 1) | (u8::from(perms[2] == b'x') << 2);
        if !matches!(perms[0], b'r' | b'-') || !matches!(perms[1], b'w' | b'-') || !matches!(perms[2], b'x' | b'-') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "malformed mapping permissions",
            ));
        }
        let offset = u64::from_str_radix(fields[2], 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad mapping offset"))?;
        let (major, minor) = fields[3]
            .split_once(':')
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "bad mapping device"))?;
        let device_major = u32::from_str_radix(major, 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad device major"))?;
        let device_minor = u32::from_str_radix(minor, 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad device minor"))?;
        let inode = fields[4]
            .parse::<u64>()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad mapping inode"))?;
        if fields.len() > 6 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unescaped whitespace in mapping path",
            ));
        }
        let encoded_path = fields.get(5).copied().unwrap_or("");
        let decoded_path = decode_maps_path(encoded_path.as_bytes())?;
        let path = std::str::from_utf8(&decoded_path)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 mapping path"))?;
        let kernel_special = matches!(path, "[vdso]" | "[vvar]" | "[vvar_vclock]" | "[vsyscall]");
        let root_relative = if path.starts_with('/') {
            if path.ends_with(" (deleted)") {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "deleted file mapping has no immutable identity",
                ));
            }
            let relative = path.strip_prefix('/').expect("absolute path");
            if !canonical_relative(relative.as_bytes()) || relative.as_bytes().len() > MAX_PATH_BYTES {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "mapping path exceeds bound"));
            }
            let file = std::fs::File::open(root.join(relative))?;
            let metadata = file.metadata()?;
            if metadata.ino() != inode
                || libc::major(metadata.dev()) as u32 != device_major
                || libc::minor(metadata.dev()) as u32 != device_minor
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "file mapping identity changed",
                ));
            }
            Some((
                relative.as_bytes().to_vec(),
                hash_file_range(&file, offset, end - start, deadline)?,
            ))
        } else {
            if inode != 0 || device_major != 0 || device_minor != 0 || offset != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "anonymous mapping carries file identity",
                ));
            }
            None
        };
        let (root_relative, file_digest) =
            root_relative.map_or((None, None), |(path, digest)| (Some(path), Some(digest)));
        mappings.push(NativeMapping {
            start,
            end,
            offset,
            protection,
            device_major,
            device_minor,
            inode,
            kernel_special,
            root_relative,
            file_digest,
            bytes: Vec::new(),
        });
    }
    Ok(mappings)
}

#[cfg(target_os = "linux")]
fn decode_maps_path(encoded: &[u8]) -> io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(encoded.len());
    let mut at = 0;
    while at < encoded.len() {
        if encoded[at] != b'\\' {
            out.push(encoded[at]);
            at += 1;
            continue;
        }
        let escape = encoded
            .get(at + 1..at + 4)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed maps escape"))?;
        let byte = match escape {
            b"040" => b' ',
            b"011" => b'\t',
            b"012" => b'\n',
            b"134" => b'\\',
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "unknown maps escape")),
        };
        out.push(byte);
        at += 4;
    }
    Ok(out)
}

#[cfg(target_os = "linux")]
fn hash_file_range(file: &std::fs::File, offset: u64, mapping_len: u64, deadline: Instant) -> io::Result<[u8; 32]> {
    let available = file.metadata()?.len().saturating_sub(offset).min(mapping_len);
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; (1 << 20).min(usize::try_from(available).unwrap_or(1 << 20))];
    let mut done = 0u64;
    while done < available {
        check_deadline(deadline)?;
        let count = buffer
            .len()
            .min(usize::try_from(available - done).unwrap_or(buffer.len()));
        let read = file.read_at(&mut buffer[..count], offset + done)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "file mapping changed while hashing",
            ));
        }
        hash.update(&buffer[..read]);
        done += read as u64;
    }
    Ok(hash.finalize().into())
}

#[cfg(target_os = "linux")]
fn read_process_mem_exact(memory: &std::fs::File, start: u64, length: usize, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0u8; length];
    let mut done = 0usize;
    while done < length {
        check_deadline(deadline)?;
        let count = (length - done).min(1 << 20);
        let read = memory.read_at(&mut bytes[done..done + count], start + done as u64)?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "unreadable anonymous process mapping",
            ));
        }
        done += read;
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn read_process_exact(pid: libc::pid_t, start: u64, length: usize, deadline: Instant) -> io::Result<Vec<u8>> {
    const CHUNK: usize = 1 << 20;
    let mut bytes = vec![0_u8; length];
    let mut done = 0usize;
    while done < length {
        check_deadline(deadline)?;
        let count = (length - done).min(CHUNK);
        let mut local = libc::iovec {
            iov_base: bytes[done..done + count].as_mut_ptr().cast(),
            iov_len: count,
        };
        let remote_address = start
            .checked_add(done as u64)
            .and_then(|address| usize::try_from(address).ok())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "mapping address overflow"))?;
        let remote = libc::iovec {
            iov_base: remote_address as *mut libc::c_void,
            iov_len: count,
        };
        let read = unsafe { libc::process_vm_readv(pid, &raw mut local, 1, &raw const remote, 1, 0) };
        if read < 0 {
            return Err(io::Error::last_os_error());
        }
        if read as usize != count {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "partial process memory read",
            ));
        }
        done += count;
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn check_deadline(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "native memory capture deadline elapsed",
        ))
    } else {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn ensure_same_maps(before: &[u8], after: &[u8]) -> io::Result<()> {
    if before == after {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process map table changed during capture",
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InvalidRecord {
    Size,
    Magic,
    Version,
    Architecture,
    DeclaredSize,
    Reserved,
}

impl X86RegisterRecord {
    pub(super) fn encode(&self) -> [u8; RECORD_SIZE] {
        let mut bytes = [0_u8; RECORD_SIZE];
        bytes[..8].copy_from_slice(MAGIC);
        bytes[8..10].copy_from_slice(&VERSION.to_le_bytes());
        bytes[10..12].copy_from_slice(&ELF_MACHINE_X86_64.to_le_bytes());
        bytes[12..16].copy_from_slice(&(RECORD_SIZE as u32).to_le_bytes());
        bytes[16..24].copy_from_slice(&self.signal_mask.to_le_bytes());
        for (index, value) in self.registers.iter().enumerate() {
            let start = REGISTER_OFFSET + index * 8;
            bytes[start..start + 8].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<Self, InvalidRecord> {
        let bytes: &[u8; RECORD_SIZE] = bytes.try_into().map_err(|_| InvalidRecord::Size)?;
        if &bytes[..8] != MAGIC {
            return Err(InvalidRecord::Magic);
        }
        if u16::from_le_bytes(bytes[8..10].try_into().expect("fixed field")) != VERSION {
            return Err(InvalidRecord::Version);
        }
        if u16::from_le_bytes(bytes[10..12].try_into().expect("fixed field")) != ELF_MACHINE_X86_64 {
            return Err(InvalidRecord::Architecture);
        }
        if u32::from_le_bytes(bytes[12..16].try_into().expect("fixed field")) as usize != RECORD_SIZE {
            return Err(InvalidRecord::DeclaredSize);
        }
        if bytes[24..32].iter().chain(&bytes[248..]).any(|byte| *byte != 0) {
            return Err(InvalidRecord::Reserved);
        }
        let mut registers = [0; REGISTER_COUNT];
        for (index, value) in registers.iter_mut().enumerate() {
            let start = REGISTER_OFFSET + index * 8;
            *value = u64::from_le_bytes(bytes[start..start + 8].try_into().expect("fixed field"));
        }
        Ok(Self {
            signal_mask: u64::from_le_bytes(bytes[16..24].try_into().expect("fixed field")),
            registers,
        })
    }
}

/// One stopped thread's complete architectural state.
///
/// Deliberately a container of per-mechanism records rather than a widened
/// `X86RegisterRecord`: an aarch64 sibling is a different set of regsets, not
/// more fields on this one.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct NativeThreadState {
    pub(super) registers: X86RegisterRecord,
    pub(super) xstate: X86XstateRecord,
}

#[cfg(target_arch = "x86_64")]
pub(super) fn capture(pid: libc::pid_t) -> io::Result<NativeThreadState> {
    capture_with_until(pid, Instant::now() + STOP_DEADLINE, || Ok(()), || Ok(())).map(|(thread, ())| thread)
}

#[cfg(target_arch = "x86_64")]
fn capture_until(pid: libc::pid_t, deadline: Instant) -> io::Result<NativeThreadState> {
    capture_with_until(pid, deadline, || Ok(()), || Ok(())).map(|(thread, ())| thread)
}

/// Captures the architectural thread state and the memory image under a
/// **single** ptrace attachment.
///
/// The two halves used to be captured under two separate attachments, which
/// meant `PTRACE_DETACH` ran between them.  Detaching a tracee that was in
/// group-stop does not leave it stopped instantaneously: the kernel re-arms
/// `JOBCTL_STOP_PENDING` and wakes the task so it can re-enter group stop, so
/// there is a window in which `/proc/<pid>/status` reports a runnable state.
/// `capture_stopped_memory` admits its target by reading exactly that field,
/// once, with no retry and without consulting the deadline -- so whenever the
/// tracee had not been scheduled back into its stop yet, capture failed with
/// `RuntimeConstruction` no matter how much of the budget was left.  That is
/// why the failure was contention-sensitive rather than deadline-sensitive.
///
/// Holding one attachment across both halves removes the window rather than
/// polling around it, and buys a correctness property the split never had: the
/// registers and the memory image now come from the same frozen instant.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn capture_thread_and_memory_until(
    pid: libc::pid_t,
    deadline: Instant,
) -> io::Result<(NativeThreadState, NativeMemoryImage)> {
    // While attached the tracee sits in ptrace-stop, which `process_is_stopped`
    // recognises as `t`, so the memory half's admission check still applies.
    capture_with_until(pid, deadline, || Ok(()), || capture_stopped_memory(pid, deadline))
}

#[cfg(all(target_os = "linux", not(target_arch = "x86_64")))]
fn capture_thread_and_memory_until(
    pid: libc::pid_t,
    deadline: Instant,
) -> io::Result<(NativeThreadState, NativeMemoryImage)> {
    let thread = capture_until(pid, deadline)?;
    let memory = capture_stopped_memory(pid, deadline)?;
    Ok((thread, memory))
}

#[cfg(not(target_arch = "x86_64"))]
fn capture_until(pid: libc::pid_t, _deadline: Instant) -> io::Result<NativeThreadState> {
    capture(pid)
}

/// aarch64 and every other host stays refusing.  Returning `Unsupported` is why
/// it is safe today; returning success without the FP/vector file is what made
/// x86-64 unsafe.  An aarch64 record would need `NT_PRSTATUS`, `NT_FPREGSET`
/// (Q0-31, FPSR, FPCR), `NT_ARM_TLS` for `TPIDR_EL0` -- easy to forget, since
/// x86-64 carries FS/GS base inside `user_regs_struct` -- and `NT_ARM_SVE` /
/// `NT_ARM_ZA`, whose payloads are prefixed by a vector length that must be set
/// before the payload is written back.
#[cfg(not(target_arch = "x86_64"))]
pub(super) fn capture(_pid: libc::pid_t) -> io::Result<NativeThreadState> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "native-x86 architectural capture requires a Linux x86-64 host",
    ))
}

#[cfg(target_arch = "x86_64")]
fn capture_with(pid: libc::pid_t, after_stop: impl FnOnce() -> io::Result<()>) -> io::Result<NativeThreadState> {
    capture_with_until(pid, Instant::now() + STOP_DEADLINE, after_stop, || Ok(())).map(|(thread, ())| thread)
}

/// `after_stop` runs as soon as the stop has been *observed*; `while_attached`
/// runs after the architectural state has been read and before the tracee is
/// detached, so anything it captures is guaranteed to come from the same stop.
#[cfg(target_arch = "x86_64")]
fn capture_with_until<T>(
    pid: libc::pid_t,
    deadline: Instant,
    after_stop: impl FnOnce() -> io::Result<()>,
    while_attached: impl FnOnce() -> io::Result<T>,
) -> io::Result<(NativeThreadState, T)> {
    if pid <= 1 || pid == unsafe { libc::getpid() } {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "capture target must be another live process",
        ));
    }
    check_deadline(deadline)?;
    ptrace(libc::PTRACE_SEIZE, pid, 0, 0)?;
    let mut guard = TraceGuard {
        pid,
        was_group_stopped: false,
        ptrace_stopped: false,
    };
    check_deadline(deadline)?;
    ptrace(libc::PTRACE_INTERRUPT, pid, 0, 0)?;
    guard.was_group_stopped = wait_for_ptrace_stop_until(pid, deadline)?;
    guard.ptrace_stopped = true;
    refuse_unrepresentable_threads(pid)?;
    after_stop()?;
    check_deadline(deadline)?;

    let mut raw: libc::user_regs_struct = unsafe { std::mem::zeroed() };
    let mut iov = libc::iovec {
        iov_base: (&raw mut raw).cast(),
        iov_len: std::mem::size_of_val(&raw),
    };
    check_deadline(deadline)?;
    ptrace(
        libc::PTRACE_GETREGSET,
        pid,
        libc::NT_PRSTATUS as usize,
        (&raw mut iov) as usize,
    )?;
    if iov.iov_len != std::mem::size_of_val(&raw) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "short x86-64 NT_PRSTATUS register set",
        ));
    }
    let mut signal_mask = 0_u64;
    check_deadline(deadline)?;
    ptrace(
        libc::PTRACE_GETSIGMASK,
        pid,
        std::mem::size_of_val(&signal_mask),
        (&raw mut signal_mask) as usize,
    )?;
    let registers = unsafe { std::ptr::read_unaligned((&raw const raw).cast::<[u64; REGISTER_COUNT]>()) };
    check_deadline(deadline)?;
    let xstate = capture_xstate(pid)?;
    // Still attached: the tracee cannot leave this stop underneath the caller.
    let attached = while_attached()?;
    drop(guard);
    Ok((
        NativeThreadState {
            registers: X86RegisterRecord { signal_mask, registers },
            xstate,
        },
        attached,
    ))
}

/// Reads the whole extended processor state through `NT_X86_XSTATE`.
///
/// The XSAVE area is not a fixed-size structure: `CPUID.(EAX=0Dh,ECX=0)` and the
/// enabled `XCR0` decide its size, so nothing here hardcodes 832 or 2696.  The
/// kernel clamps `iov_len` to the regset's own length and writes the copied
/// length back, so a generous buffer makes the kernel authoritative -- the same
/// contract the `NT_PRSTATUS` read above already relies on.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn capture_xstate(pid: libc::pid_t) -> io::Result<X86XstateRecord> {
    let xcr0 = host_xcr0().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "native-x86 capture requires an XSAVE-enabled host",
        )
    })?;
    let mut area = vec![0_u8; XSTATE_MAX_AREA];
    let mut iov = libc::iovec {
        iov_base: area.as_mut_ptr().cast(),
        iov_len: area.len(),
    };
    ptrace(
        libc::PTRACE_GETREGSET,
        pid,
        NT_X86_XSTATE as usize,
        (&raw mut iov) as usize,
    )?;
    if iov.iov_len < XSTATE_MIN_AREA || iov.iov_len >= area.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "implausible x86-64 NT_X86_XSTATE register set length",
        ));
    }
    area.truncate(iov.iov_len);
    let record = X86XstateRecord { xcr0, area };
    // Refuse to publish an area we could not decode back; capture and restore
    // must agree on validity before anything reaches a manifest.
    X86XstateRecord::decode(&record.encode())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("invalid xstate capture: {error:?}")))
}

/// Refuses a target that carries threads the image has no slot for.
///
/// `native-x86-v1` holds exactly **one** `X86RegisterRecord` and **one**
/// `X86XstateRecord`, and both are read from the pid the caller names -- the
/// thread-group leader in every production path.  A sibling thread's register
/// file, extended state and signal mask are not merely left un-restored: they
/// are never captured at all, so a "restored" multi-threaded process would run
/// one thread from the image and every other thread from whatever the fresh
/// process happened to hold.  There is no honest zero fill for a live thread and
/// nothing to reconstruct it from, so this is a refusal on both sides -- capture
/// and restore -- and it is taken while the target is stopped, so the count
/// cannot change underneath the decision.
#[cfg(target_os = "linux")]
fn refuse_unrepresentable_threads(pid: libc::pid_t) -> io::Result<()> {
    let mut threads = 0_usize;
    for entry in std::fs::read_dir(format!("/proc/{pid}/task"))? {
        entry?;
        threads += 1;
    }
    if threads != 1 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("native-x86 image represents one thread; target carries {threads}"),
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn process_is_stopped(pid: libc::pid_t) -> io::Result<bool> {
    let status = std::fs::read(format!("/proc/{pid}/status"))?;
    let state = status
        .split(|byte| *byte == b'\n')
        .find(|line| line.starts_with(b"State:"))
        .and_then(|line| line.get(7).copied())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing process state"))?;
    Ok(matches!(state, b'T' | b't'))
}

#[cfg(target_arch = "x86_64")]
fn wait_for_ptrace_stop(pid: libc::pid_t, timeout: Duration) -> io::Result<bool> {
    wait_for_ptrace_stop_until(pid, Instant::now() + timeout)
}

#[cfg(target_arch = "x86_64")]
fn wait_for_ptrace_stop_until(pid: libc::pid_t, deadline: Instant) -> io::Result<bool> {
    loop {
        check_deadline(deadline)?;
        // Observe death without collecting it. The process owner must retain the exit status.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let observed = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &raw mut info,
                libc::WEXITED | libc::WSTOPPED | libc::WNOHANG | libc::WNOWAIT | libc::__WALL,
            )
        };
        if observed < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        } else if unsafe { info.si_pid() } == pid
            && matches!(info.si_code, libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED)
        {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "tracee exited before register capture",
            ));
        }

        let mut status = 0;
        let waited = unsafe { libc::waitpid(pid, &raw mut status, libc::__WALL | libc::WNOHANG) };
        if waited < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if waited == pid && libc::WIFSTOPPED(status) {
            let event = status >> 16;
            if event != libc::PTRACE_EVENT_STOP {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected ptrace stop"));
            }
            // A seized tracee reports PTRACE_EVENT_STOP/SIGTRAP for PTRACE_INTERRUPT.
            // A pre-existing group-stop reports the actual stopping signal instead.
            return Ok(libc::WSTOPSIG(status) != libc::SIGTRAP);
        }
        if waited == pid {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected tracee event"));
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out waiting for ptrace stop",
            ));
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[cfg(target_arch = "x86_64")]
fn ptrace(request: libc::c_uint, pid: libc::pid_t, address: usize, data: usize) -> io::Result<()> {
    let result = unsafe { libc::ptrace(request, pid, address as *mut libc::c_void, data as *mut libc::c_void) };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_arch = "x86_64")]
struct TraceGuard {
    pid: libc::pid_t,
    was_group_stopped: bool,
    ptrace_stopped: bool,
}

#[cfg(target_arch = "x86_64")]
impl Drop for TraceGuard {
    fn drop(&mut self) {
        // Cleanup must not wait: a destructor cannot safely depend on an untrusted tracee making
        // another transition. A stopped tracee can be detached; otherwise this best-effort detach
        // either succeeds immediately or the kernel releases the relationship when the task exits.
        let signal = if self.was_group_stopped {
            libc::SIGSTOP as usize
        } else {
            0
        };
        if self.ptrace_stopped {
            let _ = ptrace(libc::PTRACE_DETACH, self.pid, 0, signal);
        } else {
            let _ = ptrace(libc::PTRACE_DETACH, self.pid, 0, 0);
        }
    }
}

#[cfg(all(test, target_arch = "x86_64"))]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::num::NonZeroU64;
    use std::os::fd::RawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct AtomicSink {
        state: Mutex<(BTreeMap<String, Vec<u8>>, BTreeMap<String, Vec<u8>>, usize, bool)>,
        fail_at: Option<&'static str>,
        begin_failure: bool,
        expire_at: Option<&'static str>,
    }

    static mut FRESH_EXEC_SENTINEL: u64 = 0;

    /// Writes `bytes` to `path` with raw syscalls only.
    ///
    /// Every publisher below runs in a freshly forked, single-threaded leaf of a
    /// multi-threaded harness, where libc's allocator may be holding a lock whose
    /// owner did not survive the fork.  Nothing here allocates or takes a lock.
    fn fixture_publish(path: &std::ffi::CStr, bytes: &[u8]) -> bool {
        unsafe {
            let fd = libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_TRUNC);
            if fd < 0 {
                return false;
            }
            let mut written = 0;
            while written < bytes.len() {
                let count = libc::write(fd, bytes[written..].as_ptr().cast(), bytes.len() - written);
                if count <= 0 {
                    libc::close(fd);
                    return false;
                }
                written += count as usize;
            }
            libc::close(fd);
            true
        }
    }

    /// Fixed-width hex, so two incarnations publish identically sized rendezvous
    /// lines and allocate identically on the way there.
    fn fixture_hex16(value: u64) -> [u8; 16] {
        let mut out = [0; 16];
        for (slot, byte) in out.iter_mut().enumerate() {
            *byte = b"0123456789abcdef"[(value >> (60 - 4 * slot) & 0xf) as usize];
        }
        out
    }

    fn fixture_hex_pair(first: u64, second: u64) -> [u8; 34] {
        let mut out = [b' '; 34];
        out[..16].copy_from_slice(&fixture_hex16(first));
        out[17..33].copy_from_slice(&fixture_hex16(second));
        out[33] = b'\n';
        out
    }

    fn spawn_fresh_exec_restore_child(test: &str, rendezvous: &Path) -> (Child, libc::pid_t, u64) {
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args(["--exact", test, "--nocapture", "--test-threads=1"])
            .env("HL_ENGINE_NATIVE_RESTORE_CHILD", "1")
            .env("HL_ENGINE_NATIVE_RESTORE_RENDEZVOUS", rendezvous)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        unsafe {
            command.pre_exec(|| {
                let current = libc::personality(!0_u64 as libc::c_ulong);
                if current < 0
                    || libc::personality((current as libc::c_ulong) | libc::ADDR_NO_RANDOMIZE as libc::c_ulong) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().expect("spawn fresh-exec restore child");
        let deadline = Instant::now() + Duration::from_secs(10);
        let (leaf, address) = loop {
            if let Ok(value) = std::fs::read_to_string(rendezvous)
                && let Some((leaf, address)) = value.trim().split_once(' ')
                && let Ok(leaf) = i64::from_str_radix(leaf.trim(), 16)
                && let Ok(address) = u64::from_str_radix(address.trim(), 16)
                && leaf > 0
            {
                break (leaf as libc::pid_t, address);
            }
            assert!(
                Instant::now() < deadline,
                "fresh-exec child did not publish its sentinel address"
            );
            std::thread::yield_now();
        };
        wait_until_stopped(leaf);
        (child, leaf, address)
    }

    impl CheckpointSink for AtomicSink {
        fn replace(&self, _: &[u8]) -> Result<(), CompositionError> {
            unreachable!()
        }
        fn begin_until(&self, _: Instant) -> Result<NonZeroU64, CompositionError> {
            if self.begin_failure {
                return Err(CompositionError::TransactionBusy);
            }
            let mut state = self.state.lock().unwrap();
            if state.3 {
                return Err(CompositionError::TransactionBusy);
            }
            state.3 = true;
            Ok(NonZeroU64::new(1).unwrap())
        }
        fn put_until(
            &self,
            _: NonZeroU64,
            name: &str,
            bytes: &[u8],
            deadline: Instant,
        ) -> Result<(), CompositionError> {
            if self.expire_at == Some(name) {
                while Instant::now() < deadline {
                    std::thread::yield_now();
                }
                return Err(CompositionError::DeadlineExceeded);
            }
            if self.fail_at == Some(name) {
                return Err(CompositionError::RuntimeConstruction);
            }
            self.state.lock().unwrap().1.insert(name.to_owned(), bytes.to_vec());
            Ok(())
        }
        fn abort_until(&self, _: NonZeroU64, deadline: Instant) -> Result<(), CompositionError> {
            if Instant::now() >= deadline {
                return Err(CompositionError::DeadlineExceeded);
            }
            let mut state = self.state.lock().unwrap();
            state.1.clear();
            state.2 += 1;
            state.3 = false;
            Ok(())
        }
        fn commit_until(&self, _: NonZeroU64, manifest: &[u8], _: Instant) -> Result<(), CompositionError> {
            if self.fail_at == Some("commit") {
                return Err(CompositionError::RuntimeConstruction);
            }
            let mut state = self.state.lock().unwrap();
            let staging = std::mem::take(&mut state.1);
            state.0 = staging;
            state.0.insert("MANIFEST".into(), manifest.to_vec());
            state.3 = false;
            Ok(())
        }
    }

    fn stopped_child() -> libc::pid_t {
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            loop {
                unsafe { libc::pause() };
            }
        }
        assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
        wait_until_stopped(pid);
        pid
    }

    /// Runs one live-capture test alone in a child process.
    ///
    /// The child's output goes to a *file*, deliberately not to the pipes
    /// `Command::output()` would create.  Several fixtures in this module fork a
    /// child that never execs and parks in `pause()`, and such a child inherits
    /// every descriptor that was open at fork time -- including the write ends of
    /// those pipes.  If the isolated run then panics before it reaps its fixture,
    /// the leaked fixture holds the pipe open indefinitely, `output()` blocks
    /// waiting for an EOF that can never arrive, and a clean test failure becomes
    /// an unkillable hang (which also strands every other descriptor the fixture
    /// inherited, the shared box lock among them).  A file has no EOF to wait for:
    /// `status()` returns as soon as the child itself exits, so the isolated run
    /// always reports its real result.
    fn isolated_live_capture(test: &str) -> bool {
        const CHILD: &str = "HL_ENGINE_NATIVE_SNAPSHOT_CHILD";
        if std::env::var_os(CHILD).is_some() {
            return false;
        }
        let log = tempfile::NamedTempFile::new().expect("isolated capture log");
        let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
            .args(["--exact", test, "--nocapture", "--test-threads=1"])
            .env(CHILD, "1")
            .stdin(Stdio::null())
            .stdout(log.reopen().expect("isolated capture stdout"))
            .stderr(log.reopen().expect("isolated capture stderr"))
            .status()
            .expect("spawn isolated native snapshot test");
        assert!(
            status.success(),
            "isolated native snapshot test failed: {}",
            std::fs::read_to_string(log.path()).unwrap_or_default()
        );
        true
    }

    #[test]
    fn native_transaction_publishes_only_a_complete_validated_generation() {
        if isolated_live_capture(
            "runtime::execution::native_snapshot::tests::native_transaction_publishes_only_a_complete_validated_generation",
        ) {
            return;
        }
        let pid = stopped_child();
        let sink = AtomicSink::default();
        publish_stopped_native(&sink, pid, Instant::now() + Duration::from_secs(10)).unwrap();
        let state = sink.state.lock().unwrap();
        assert_eq!(state.0.len(), 5);
        assert_eq!(
            crate::runtime::checkpoint::image_envelope::Reader::decode(&state.0["IMAGE"]),
            Ok(crate::runtime::checkpoint::image_envelope::Reader::NativeX86),
        );
        assert_eq!(
            validate_native_objects(&state.0["MANIFEST"], |name| state.0.get(name).cloned()),
            Ok(())
        );
        let mut tampered = state.0.clone();
        tampered.get_mut(MEMORY_OBJECT).unwrap()[0] ^= 1;
        assert_eq!(
            validate_native_objects(&state.0["MANIFEST"], |name| tampered.get(name).cloned()),
            Err(InvalidNativeImage::Digest)
        );
        assert_eq!(
            validate_native_objects(&state.0["MANIFEST"], |name| (name != REGISTER_OBJECT)
                .then(|| state.0[name].clone())),
            Err(InvalidNativeImage::Missing)
        );
        drop(state);
        kill_and_reap(pid);
    }

    #[test]
    fn native_image_restores_a_separately_execed_process_after_the_original_is_reaped() {
        const TEST: &str = "runtime::execution::native_snapshot::tests::native_image_restores_a_separately_execed_process_after_the_original_is_reaped";
        const CAPTURED: u64 = 0x5a71_cafe_9876_4321;
        // The parked side is a *forked leaf*, not this harness.  A `libtest`
        // process carries two threads, and the image has a slot for exactly one:
        // checkpointing the harness would capture the thread-group leader parked
        // in libc's join and never see the thread that set the sentinel at all.
        // `refuse_unrepresentable_threads` now says so out loud; before it did,
        // this fixture quietly proved only that memory round-trips.
        if let Some(rendezvous) = std::env::var_os("HL_ENGINE_NATIVE_RESTORE_RENDEZVOUS")
            && std::env::var_os("HL_ENGINE_NATIVE_RESTORE_CHILD").is_some()
        {
            let published =
                std::ffi::CString::new(Path::new(&rendezvous).as_os_str().as_encoded_bytes()).expect("rendezvous path");
            let leaf = unsafe { libc::fork() };
            assert!(leaf >= 0, "fork single-threaded leaf");
            if leaf == 0 {
                unsafe {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                    libc::alarm(120);
                    std::ptr::write_volatile(&raw mut FRESH_EXEC_SENTINEL, CAPTURED);
                    let line = fixture_hex_pair(libc::getpid() as u64, (&raw const FRESH_EXEC_SENTINEL) as u64);
                    if !fixture_publish(&published, &line) {
                        libc::_exit(4);
                    }
                    libc::raise(libc::SIGSTOP);
                    libc::_exit((std::ptr::read_volatile(&raw const FRESH_EXEC_SENTINEL) != CAPTURED) as libc::c_int);
                }
            }
            let mut status = 0;
            let waited = unsafe { libc::waitpid(leaf, &mut status, 0) };
            std::process::exit(if waited != leaf {
                5
            } else if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else {
                6
            });
        }

        let rendezvous = tempfile::NamedTempFile::new().unwrap();
        let (mut original, original_pid, original_address) = spawn_fresh_exec_restore_child(TEST, rendezvous.path());
        let capture_started = Instant::now();
        let image = capture_stopped_native(original_pid, Instant::now() + Duration::from_secs(10)).unwrap();
        let capture_elapsed = capture_started.elapsed();
        assert_eq!(unsafe { libc::kill(original_pid, libc::SIGKILL) }, 0);
        if unsafe { libc::kill(original_pid, libc::SIGCONT) } != 0 {
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH),
                "SIGCONT after SIGKILL may only fail because the leaf was already reaped"
            );
        }
        assert_eq!(
            original.wait().unwrap().code(),
            Some(6),
            "original harness must reap a killed leaf before restore"
        );

        std::fs::write(rendezvous.path(), b"").unwrap();
        let (mut replacement, replacement_pid, replacement_address) =
            spawn_fresh_exec_restore_child(TEST, rendezvous.path());
        assert_ne!(replacement_pid, original_pid);
        assert_eq!(
            replacement_address, original_address,
            "ASLR-disabled fresh exec must reproduce layout"
        );
        let memory = std::fs::OpenOptions::new()
            .write(true)
            .open(format!("/proc/{replacement_pid}/mem"))
            .unwrap();
        memory
            .write_all_at(&0xdead_beef_dead_beef_u64.to_ne_bytes(), replacement_address)
            .unwrap();
        let restore_started = Instant::now();
        let replacement_pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, replacement_pid, 0) } as RawFd;
        assert!(replacement_pidfd >= 0, "pidfd_open replacement");
        let substituted_pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as RawFd;
        assert!(substituted_pidfd >= 0, "pidfd_open substitution");
        assert!(
            !process_incarnation_matches(replacement_pid, substituted_pidfd).unwrap(),
            "numeric target accepted a pidfd for another process incarnation"
        );
        unsafe { libc::close(substituted_pidfd) };
        let prepared = prepare_native_restore(
            replacement_pid,
            unsafe { OwnedFd::from_raw_fd(replacement_pidfd) },
            &image.registers,
            &image.memory,
            &image.xstate,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        complete_native_restore(prepared, Instant::now() + Duration::from_secs(10)).unwrap();
        let restore_elapsed = restore_started.elapsed();
        assert_eq!(unsafe { libc::kill(replacement_pid, libc::SIGCONT) }, 0);
        assert!(
            replacement.wait().unwrap().success(),
            "restored process must resume at captured state"
        );
        eprintln!(
            "native fresh-exec capture_us={} restore_us={}",
            capture_elapsed.as_micros(),
            restore_elapsed.as_micros()
        );
    }

    // ---------------------------------------------------------------------
    // General-purpose register fidelity.
    //
    // The fresh-exec test above restores into a second exec of the same binary
    // with ASLR disabled, identical argv and an identical parking point, and
    // then asserts only a *memory* sentinel.  Every architectural register the
    // replacement already carries is therefore coincidentally correct, and
    // deleting the `NT_PRSTATUS` `PTRACE_SETREGSET` from `complete_native_restore`
    // leaves that test -- and the whole native snapshot suite -- green.
    //
    // This fixture removes the coincidence.  Two incarnations of the same binary
    // park with register state that is *deterministically different*:
    //
    //   * r12/r13/r14/r15/rbx/rbp hold values derived from the incarnation's own
    //     pid, which the parent asserts are distinct;
    //   * rip is inside a sixteen-slot sled of `syscall` instructions, and the
    //     incarnation index picks the slot -- so the two stop at addresses eight
    //     bytes apart and a fresh exec never reaches the captured one;
    //   * rsp carries an index-derived displacement;
    //   * fs_base is repointed by `arch_prctl(ARCH_SET_FS)` into an index-derived
    //     offset of a fixture pad, so the TLS base genuinely differs across execs;
    //   * the blocked signal mask is derived from the pid *and* the index.
    //
    // Nothing after `ARCH_SET_FS` may touch the TLS, so the whole parking and
    // verification sequence is raw assembly ending in `exit_group`; libc is never
    // re-entered.  `DF` is left set across the stop and cleared on resume before
    // any string operation could observe it.
    const REGFID_XOR: u64 = 0x5a5a_5a5a_5a5a_5a5a;
    const REGFID_MUL: u64 = 0x9e37_79b9_7f4a_7c15;
    const REGFID_ADD: u64 = 0x1234_5678_9abc_def0;
    const REGFID_BP: u64 = 0xf0f0_f0f0_f0f0_f0f0;
    const REGFID_TAG: u64 = 0x00c0_ffee;

    /// `user_regs_struct` slot indices inside `X86RegisterRecord::registers`.
    const REG_R15: usize = 0;
    const REG_R14: usize = 1;
    const REG_R13: usize = 2;
    const REG_R12: usize = 3;
    const REG_RBP: usize = 4;
    const REG_RBX: usize = 5;
    const REG_ORIG_RAX: usize = 15;
    const REG_RIP: usize = 16;
    const REG_CS: usize = 17;
    const REG_RSP: usize = 19;
    const REG_SS: usize = 20;
    const REG_FS_BASE: usize = 21;

    /// The record is a byte-for-byte `user_regs_struct`, and the names above are
    /// only meaningful while that stays true.
    const _: () = {
        assert!(REGISTER_COUNT == 27);
        assert!(std::mem::size_of::<libc::user_regs_struct>() == REGISTER_COUNT * 8);
    };

    /// Slots the two incarnations are *built* to disagree on.
    const REGFID_DISCRIMINATING: [(&str, usize); 9] = [
        ("r15", REG_R15),
        ("r14", REG_R14),
        ("r13", REG_R13),
        ("r12", REG_R12),
        ("rbp", REG_RBP),
        ("rbx", REG_RBX),
        ("rip", REG_RIP),
        ("rsp", REG_RSP),
        ("fs_base", REG_FS_BASE),
    ];

    /// Signals the fixture blocks, selected bit by bit from its pid.
    const REGFID_MASK_SIGNALS: [libc::c_int; 6] = [
        libc::SIGUSR1,
        libc::SIGUSR2,
        libc::SIGALRM,
        libc::SIGCHLD,
        libc::SIGURG,
        libc::SIGWINCH,
    ];

    fn regfid_expected_signal_mask(pid: u64, index: u64) -> u64 {
        let mut mask = 0_u64;
        for (bit, signal) in REGFID_MASK_SIGNALS.into_iter().enumerate() {
            if pid >> bit & 1 == 1 {
                mask |= 1 << (signal - 1);
            }
        }
        if index & 1 == 1 {
            mask |= 1 << (libc::SIGPROF - 1);
        }
        mask
    }

    /// The six general-purpose sentinels, exactly as the assembly computes them.
    fn regfid_expected_gprs(pid: u64) -> [(usize, u64); 6] {
        [
            (REG_R12, pid ^ REGFID_XOR),
            (REG_R13, pid.wrapping_mul(REGFID_MUL)),
            (REG_R14, !pid),
            (REG_R15, pid << 32 | REGFID_TAG),
            (REG_RBX, pid.wrapping_add(REGFID_ADD)),
            (REG_RBP, pid ^ REGFID_BP),
        ]
    }

    unsafe extern "C" {
        /// Parks with the fixture register state, verifies it on resume and exits.
        fn hl_regfidelity_park(pid: u64, index: u64, tid: u64) -> !;
    }

    core::arch::global_asm!(
        r#"
        .text
        .globl hl_regfidelity_park
        .hidden hl_regfidelity_park
        .type hl_regfidelity_park,@function
hl_regfidelity_park:
        // rdi = pid, rsi = incarnation index, rdx = tid
        mov qword ptr [rip + hl_regfidelity_parked_pid], rdi
        mov qword ptr [rip + hl_regfidelity_parked_tid], rdx
        // slot = index * 5 + 2, so the two incarnations never collide
        lea rcx, [rsi + rsi*4]
        add rcx, 2
        and rcx, 15

        // fs_base <- tls_pad + slot * 64.  Nothing below may touch the TLS.
        mov r8, rdi
        mov r9, rcx
        mov rsi, rcx
        shl rsi, 6
        lea rdx, [rip + hl_regfidelity_tls_pad]
        add rsi, rdx
        mov eax, 158                    // SYS_arch_prctl
        mov edi, 0x1002                 // ARCH_SET_FS
        syscall
        mov rdi, r8
        mov rcx, r9

        // rsp displacement, also slot derived
        mov rdx, rcx
        shl rdx, 4
        sub rsp, rdx

        // Register sentinels, derived from this incarnation's pid.
        movabs rax, 0x5a5a5a5a5a5a5a5a
        mov r12, rdi
        xor r12, rax
        movabs rax, 0x9e3779b97f4a7c15
        mov r13, rdi
        imul r13, rax
        mov r14, rdi
        not r14
        mov r15, rdi
        shl r15, 32
        or r15, 0xc0ffee
        movabs rax, 0x123456789abcdef0
        mov rbx, rdi
        add rbx, rax
        movabs rax, 0xf0f0f0f0f0f0f0f0
        mov rbp, rdi
        xor rbp, rax

        std                             // DF must survive the checkpoint

        // Park inside the slot-selected `syscall` of the sled.
        //
        // `tgkill`, not `kill`: a *process*-directed SIGSTOP is handled by an
        // arbitrary eligible thread, and the sending thread keeps running until
        // it next passes through signal handling.  Measured on this box: a
        // fixture that sent itself a process-directed SIGSTOP and then verified
        // and `exit_group`ed never reached state `T` at all -- it exited before
        // the group stop took hold, and the harness read a clean exit 0 from a
        // process that was never checkpointed.  A thread-directed SIGSTOP (what
        // `raise()` issues, and what every other fixture in this module relies
        // on) stops *this* thread on return from the syscall, before the next
        // instruction retires.
        lea r10, [rip + 20f]
        lea r10, [r10 + rcx*8]
        mov rsi, qword ptr [rip + hl_regfidelity_parked_tid]
        mov edx, 19                     // SIGSTOP
        mov eax, 234                    // SYS_tgkill
        jmp r10
        .balign 8
20:
        .rept 16
        .balign 8
        syscall
        jmp 30f
        .endr
        .balign 8
30:
        // Resumed.  Either the image landed or it did not; report, never guess.
        pushfq
        pop rax
        cld
        xor r11d, r11d
        test rax, 0x400                 // DF
        setz cl
        or r11b, cl

        mov rdi, qword ptr [rip + hl_regfidelity_parked_pid]
        movabs rax, 0x5a5a5a5a5a5a5a5a
        xor rax, rdi
        cmp rax, r12
        setne cl
        or r11b, cl
        movabs rax, 0x9e3779b97f4a7c15
        imul rax, rdi
        cmp rax, r13
        setne cl
        or r11b, cl
        mov rax, rdi
        not rax
        cmp rax, r14
        setne cl
        or r11b, cl
        mov rax, rdi
        shl rax, 32
        or rax, 0xc0ffee
        cmp rax, r15
        setne cl
        or r11b, cl
        movabs rax, 0x123456789abcdef0
        add rax, rdi
        cmp rax, rbx
        setne cl
        or r11b, cl
        movabs rax, 0xf0f0f0f0f0f0f0f0
        xor rax, rdi
        cmp rax, rbp
        setne cl
        or r11b, cl

        movzx edi, r11b
        mov eax, 231                    // SYS_exit_group
        syscall
        ud2

        .section .bss
        .balign 64
hl_regfidelity_parked_pid:
        .zero 8
hl_regfidelity_parked_tid:
        .zero 8
hl_regfidelity_tls_pad:
        .zero 1024
        .text
        "#
    );

    const REGFID_CHILD: &str = "HL_ENGINE_NATIVE_REGFID_CHILD";
    const REGFID_INDEX: &str = "HL_ENGINE_NATIVE_REGFID_INDEX";
    const REGFID_RENDEZVOUS: &str = "HL_ENGINE_NATIVE_REGFID_RENDEZVOUS";

    /// The harness half of the fixture: fork a **single-threaded** leaf and wait
    /// for it.
    ///
    /// The leaf is what parks and what the parent checkpoints.  Capture attaches
    /// to one pid and reads one `NT_PRSTATUS`, so checkpointing this harness
    /// process directly would read the *thread-group leader* -- parked inside
    /// libc's join -- and never see the fixture thread's registers at all.
    fn regfid_child(rendezvous: &Path) -> ! {
        let index: u64 = std::env::var(REGFID_INDEX)
            .expect("incarnation index")
            .parse()
            .expect("incarnation index");
        let published = std::ffi::CString::new(rendezvous.as_os_str().as_encoded_bytes()).expect("rendezvous path");
        let leaf = unsafe { libc::fork() };
        assert!(leaf >= 0, "fork single-threaded leaf");
        if leaf == 0 {
            let pid = unsafe { libc::getpid() } as u64;
            let tid = unsafe { libc::syscall(libc::SYS_gettid) } as u64;
            unsafe {
                // Never strand a parked fixture: the parking sequence below never
                // returns to libc, so both guards have to be armed here.
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                libc::alarm(120);
                let mut set: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut set);
                for (bit, signal) in REGFID_MASK_SIGNALS.into_iter().enumerate() {
                    if pid >> bit & 1 == 1 {
                        libc::sigaddset(&mut set, signal);
                    }
                }
                if index & 1 == 1 {
                    libc::sigaddset(&mut set, libc::SIGPROF);
                }
                if libc::sigprocmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) != 0 {
                    libc::_exit(3);
                }
            }
            if !fixture_publish(&published, &fixture_hex_pair(pid, tid)) {
                unsafe { libc::_exit(4) };
            }
            unsafe { hl_regfidelity_park(pid, index, tid) }
        }
        let mut status = 0;
        let waited = unsafe { libc::waitpid(leaf, &mut status, 0) };
        let code = if waited != leaf {
            5
        } else if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            6
        };
        std::process::exit(code);
    }

    /// Spawns one incarnation and returns its harness plus the **leaf** pid.
    fn spawn_regfid_child(test: &str, rendezvous: &Path, index: u64) -> (Child, libc::pid_t) {
        std::fs::write(rendezvous, b"").expect("clear rendezvous");
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args(["--exact", test, "--nocapture", "--test-threads=1"])
            .env(REGFID_CHILD, "1")
            // One byte, so both incarnations get an identically sized environment
            // and therefore an identically sized initial stack mapping.
            .env(REGFID_INDEX, index.to_string())
            .env(REGFID_RENDEZVOUS, rendezvous)
            .stdin(Stdio::null())
            // Null, never a pipe: this fixture forks a leaf that parks forever,
            // and a leaked leaf holding a pipe's write end turns a clean failure
            // into an unkillable wait for an EOF that cannot arrive.
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        unsafe {
            command.pre_exec(|| {
                let current = libc::personality(!0_u64 as libc::c_ulong);
                if current < 0
                    || libc::personality((current as libc::c_ulong) | libc::ADDR_NO_RANDOMIZE as libc::c_ulong) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
        let child = command.spawn().expect("spawn register-fidelity child");
        let deadline = Instant::now() + Duration::from_secs(10);
        let leaf = loop {
            if let Ok(value) = std::fs::read_to_string(rendezvous)
                && let Some((leaf, _tid)) = value.trim().split_once(' ')
                && let Ok(leaf) = i64::from_str_radix(leaf.trim(), 16)
                && leaf > 0
            {
                break leaf as libc::pid_t;
            }
            assert!(
                Instant::now() < deadline,
                "register-fidelity fixture did not publish its parked leaf"
            );
            std::thread::yield_now();
        };
        wait_until_stopped(leaf);
        (child, leaf)
    }

    #[test]
    fn native_image_restores_general_purpose_registers_a_fresh_exec_cannot_reproduce() {
        const TEST: &str = "runtime::execution::native_snapshot::tests::native_image_restores_general_purpose_registers_a_fresh_exec_cannot_reproduce";
        if let Some(rendezvous) = std::env::var_os(REGFID_RENDEZVOUS)
            && std::env::var_os(REGFID_CHILD).is_some()
        {
            regfid_child(Path::new(&rendezvous));
        }
        if isolated_live_capture(TEST) {
            return;
        }

        let rendezvous = tempfile::NamedTempFile::new().unwrap();
        let (mut original, original_pid) = spawn_regfid_child(TEST, rendezvous.path(), 0);
        let image = capture_stopped_native(original_pid, Instant::now() + Duration::from_secs(10)).unwrap();
        let captured = X86RegisterRecord::decode(&image.registers).unwrap();

        // The capture must hold the fixture's own state, or every later
        // comparison is against whatever the harness happened to read.
        for (slot, expected) in regfid_expected_gprs(original_pid as u64) {
            assert_eq!(
                captured.registers[slot], expected,
                "captured slot {slot} is not the fixture sentinel"
            );
        }
        assert_eq!(
            captured.signal_mask,
            regfid_expected_signal_mask(original_pid as u64, 0),
            "captured signal mask is not the fixture's"
        );
        assert_eq!(captured.registers[REG_ORIG_RAX], 234, "fixture must park in SYS_tgkill");

        assert_eq!(unsafe { libc::kill(original_pid, libc::SIGKILL) }, 0);
        // SIGKILL already terminates a group-stopped task; this SIGCONT only
        // nudges the harness's blocking `waitpid` along and races that reap, so
        // ESRCH here means the kill worked.
        if unsafe { libc::kill(original_pid, libc::SIGCONT) } != 0 {
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH),
                "SIGCONT after SIGKILL may only fail because the leaf was already reaped"
            );
        }
        assert_eq!(
            original.wait().unwrap().code(),
            Some(6),
            "original harness must reap a killed leaf"
        );

        let (mut replacement, replacement_pid) = spawn_regfid_child(TEST, rendezvous.path(), 1);
        assert_ne!(replacement_pid, original_pid, "pid reuse would void the sentinels");

        let before = capture_until(replacement_pid, Instant::now() + Duration::from_secs(10))
            .unwrap()
            .registers;
        wait_until_stopped(replacement_pid);

        // Non-vacuity.  A battery that answered "differs" for everything would
        // prove nothing, so the negatives are bracketed by positives: `cs`, `ss`
        // and `orig_rax` are the same in both incarnations and must compare equal
        // with the very same operator, on the very same records.
        for (name, slot) in REGFID_DISCRIMINATING {
            assert_ne!(
                before.registers[slot], captured.registers[slot],
                "fresh exec reproduced the captured {name}; the fixture does not discriminate"
            );
        }
        assert_eq!(before.registers[REG_CS], captured.registers[REG_CS], "cs must match");
        assert_eq!(before.registers[REG_SS], captured.registers[REG_SS], "ss must match");
        assert_eq!(
            before.registers[REG_ORIG_RAX], captured.registers[REG_ORIG_RAX],
            "both incarnations park in SYS_tgkill"
        );
        assert_ne!(
            before.signal_mask, captured.signal_mask,
            "fresh exec reproduced the captured signal mask"
        );

        let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, replacement_pid, 0) } as RawFd;
        assert!(pidfd >= 0, "pidfd_open replacement");
        let prepared = prepare_native_restore(
            replacement_pid,
            unsafe { OwnedFd::from_raw_fd(pidfd) },
            &image.registers,
            &image.memory,
            &image.xstate,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        complete_native_restore(prepared, Instant::now() + Duration::from_secs(10)).unwrap();

        // Every one of the 27 `user_regs_struct` slots, read back from the
        // kernel, plus the signal mask.  Slot by slot, so a failure names the
        // register rather than printing two 27-element arrays.
        let after = capture_until(replacement_pid, Instant::now() + Duration::from_secs(10))
            .unwrap()
            .registers;
        wait_until_stopped(replacement_pid);
        for slot in 0..REGISTER_COUNT {
            assert_eq!(
                after.registers[slot], captured.registers[slot],
                "restored slot {slot} differs: {:#x} restored, {:#x} captured",
                after.registers[slot], captured.registers[slot]
            );
        }
        assert_eq!(
            after.signal_mask, captured.signal_mask,
            "restored signal mask differs: {:#x} restored, {:#x} captured",
            after.signal_mask, captured.signal_mask
        );

        // And end to end: the resumed process itself re-derives the sentinels
        // from restored memory and exits non-zero on any disagreement.
        assert_eq!(unsafe { libc::kill(replacement_pid, libc::SIGCONT) }, 0);
        let status = replacement.wait().unwrap();
        assert_eq!(
            status.code(),
            Some(0),
            "restored process did not resume on the captured register file: {status:?}"
        );
    }

    #[test]
    fn capture_and_restore_refuse_a_target_carrying_threads_the_image_cannot_represent() {
        const TEST: &str = "runtime::execution::native_snapshot::tests::capture_and_restore_refuse_a_target_carrying_threads_the_image_cannot_represent";
        if let Some(rendezvous) = std::env::var_os(REGFID_RENDEZVOUS)
            && std::env::var_os(REGFID_CHILD).is_some()
        {
            regfid_child(Path::new(&rendezvous));
        }
        if isolated_live_capture(TEST) {
            return;
        }

        let rendezvous = tempfile::NamedTempFile::new().unwrap();
        let (mut harness, leaf) = spawn_regfid_child(TEST, rendezvous.path(), 0);
        let harness_pid = harness.id() as libc::pid_t;

        // Positive bracket: the single-threaded leaf is admitted, by the very
        // same call, so "refused" below is a property of the target and not of
        // the fixture, the box, or a capture path that refuses everything.
        let deadline = Instant::now() + Duration::from_secs(10);
        let image = capture_stopped_native(leaf, deadline).expect("single-threaded leaf must be admitted");
        assert_eq!(count_tasks(leaf), 1, "the leaf must be single threaded");
        wait_until_stopped(leaf);

        // Negative: the harness is a `libtest` process, which carries a second
        // thread the image has no slot for.  Before this refusal existed, capture
        // silently took the thread-group leader's registers and dropped every
        // sibling's register file, FP/vector state and signal mask.
        let threads = count_tasks(harness_pid);
        assert!(threads > 1, "the harness must carry more than one thread");
        let expected = format!("native-x86 image represents one thread; target carries {threads}");
        let refused = capture_until(harness_pid, Instant::now() + Duration::from_secs(10))
            .err()
            .expect("a multi-threaded target must be refused, not partially captured");
        assert_eq!(refused.kind(), io::ErrorKind::Unsupported);
        assert_eq!(refused.to_string(), expected);

        // And on the restore side, before anything is written back.
        let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, harness_pid, 0) } as RawFd;
        assert!(pidfd >= 0, "pidfd_open harness");
        let refused = prepare_native_restore(
            harness_pid,
            unsafe { OwnedFd::from_raw_fd(pidfd) },
            &image.registers,
            &image.memory,
            &image.xstate,
            Instant::now() + Duration::from_secs(10),
        )
        .err()
        .expect("a multi-threaded restore target must be refused before mutation");
        assert_eq!(refused.kind(), io::ErrorKind::Unsupported);
        assert_eq!(refused.to_string(), expected);

        assert_eq!(unsafe { libc::kill(leaf, libc::SIGKILL) }, 0);
        if unsafe { libc::kill(leaf, libc::SIGCONT) } != 0 {
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        }
        assert_eq!(harness.wait().unwrap().code(), Some(6), "harness must reap its leaf");
    }

    fn count_tasks(pid: libc::pid_t) -> usize {
        std::fs::read_dir(format!("/proc/{pid}/task"))
            .expect("task directory")
            .count()
    }

    // ---------------------------------------------------------------------
    // FP / vector round-trip fixture.
    //
    // Layout of the fixture buffer (byte offsets are duplicated as literal
    // displacements inside the asm templates below; the const asserts keep the
    // two in step):
    //   0..4      MXCSR
    //   64..128   eight x87 integers, st(0)..st(7)
    //   128..1152 sixteen 64-byte slots, zmm0..zmm15 (the tier decides how many
    //             bytes of each slot are live: 16 SSE, 32 AVX, 64 AVX-512)
    //   1152..2176 sixteen 64-byte slots, zmm16..zmm31
    //   2176..2240 eight 64-bit opmask registers k0..k7
    const FP_MXCSR: usize = 0;
    const FP_X87: usize = 64;
    const FP_VEC: usize = 128;
    const FP_VEC_HI16: usize = 1152;
    const FP_KREG: usize = 2176;
    const FP_LEN: usize = 2240;
    const _: () = {
        assert!(FP_MXCSR == 0 && FP_X87 == 64 && FP_VEC == 128);
        assert!(FP_VEC_HI16 == 1152 && FP_KREG == 2176 && FP_LEN == 2240);
    };

    /// Deliberately non-default MXCSR: FTZ, DAZ and round-toward-+inf, with the
    /// exception masks left set. `FNINIT`/loader startup leaves 0x1f80.
    const FP_MXCSR_PATTERN: u32 = 0xdfc0;
    /// The anti-pattern the *replacement* stub loads: also non-default, and
    /// different from the captured one in FTZ, DAZ and rounding mode.
    const FP_MXCSR_ANTI: u32 = 0x3f80;
    const FP_SEED_CAPTURED: u8 = 0x5b;
    const FP_SEED_ANTI: u8 = 0xc7;

    fn fp_pattern(seed: u8, mxcsr: u32) -> Vec<u8> {
        let mut bytes = vec![0_u8; FP_LEN];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = ((index as u8).wrapping_mul(37).wrapping_add(seed)) ^ 0xa5;
        }
        bytes[FP_MXCSR..FP_MXCSR + 4].copy_from_slice(&mxcsr.to_le_bytes());
        for slot in 0..8 {
            let at = FP_X87 + slot * 8;
            let raw = u64::from_le_bytes(bytes[at..at + 8].try_into().expect("x87 slot"));
            // Any i64 is exact in the 80-bit format, so `fild`/`fistp` round-trips
            // bit for bit. Keep it positive and far from zero or one.
            let value = (raw & 0x0000_ffff_ffff_ffff) | 0x0000_0100_0000_0000;
            bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    /// 0 = SSE only, 1 = + AVX (YMM upper halves), 2 = + AVX-512 (ZMM upper
    /// halves, ZMM16-31, opmasks).
    fn fp_tier() -> u8 {
        let mut tier = 0;
        if std::arch::is_x86_feature_detected!("avx") {
            tier = 1;
        }
        if std::arch::is_x86_feature_detected!("avx512f") && std::arch::is_x86_feature_detected!("avx512bw") {
            tier = 2;
        }
        tier
    }

    fn fp_tier_names(tier: u8) -> &'static str {
        match tier {
            2 => "sse,avx,avx512",
            1 => "sse,avx",
            _ => "sse",
        }
    }

    unsafe fn fp_roundtrip_sse(pattern: *const u8, out: *mut u8, pid: i32) {
        unsafe {
            core::arch::asm!(
                "ldmxcsr [{p} + 0]",
                "movups xmm0, [{p} + 128]",
                "movups xmm1, [{p} + 192]",
                "movups xmm2, [{p} + 256]",
                "movups xmm3, [{p} + 320]",
                "movups xmm4, [{p} + 384]",
                "movups xmm5, [{p} + 448]",
                "movups xmm6, [{p} + 512]",
                "movups xmm7, [{p} + 576]",
                "movups xmm8, [{p} + 640]",
                "movups xmm9, [{p} + 704]",
                "movups xmm10, [{p} + 768]",
                "movups xmm11, [{p} + 832]",
                "movups xmm12, [{p} + 896]",
                "movups xmm13, [{p} + 960]",
                "movups xmm14, [{p} + 1024]",
                "movups xmm15, [{p} + 1088]",
                "fild qword ptr [{p} + 64]",
                "fild qword ptr [{p} + 72]",
                "fild qword ptr [{p} + 80]",
                "fild qword ptr [{p} + 88]",
                "fild qword ptr [{p} + 96]",
                "fild qword ptr [{p} + 104]",
                "fild qword ptr [{p} + 112]",
                "fild qword ptr [{p} + 120]",
                "syscall",
                "stmxcsr [{o} + 0]",
                "movups [{o} + 128], xmm0",
                "movups [{o} + 192], xmm1",
                "movups [{o} + 256], xmm2",
                "movups [{o} + 320], xmm3",
                "movups [{o} + 384], xmm4",
                "movups [{o} + 448], xmm5",
                "movups [{o} + 512], xmm6",
                "movups [{o} + 576], xmm7",
                "movups [{o} + 640], xmm8",
                "movups [{o} + 704], xmm9",
                "movups [{o} + 768], xmm10",
                "movups [{o} + 832], xmm11",
                "movups [{o} + 896], xmm12",
                "movups [{o} + 960], xmm13",
                "movups [{o} + 1024], xmm14",
                "movups [{o} + 1088], xmm15",
                "fistp qword ptr [{o} + 120]",
                "fistp qword ptr [{o} + 112]",
                "fistp qword ptr [{o} + 104]",
                "fistp qword ptr [{o} + 96]",
                "fistp qword ptr [{o} + 88]",
                "fistp qword ptr [{o} + 80]",
                "fistp qword ptr [{o} + 72]",
                "fistp qword ptr [{o} + 64]",
                p = in(reg) pattern,
                o = in(reg) out,
                inlateout("rax") 62_i64 => _,
                in("rdi") pid,
                in("rsi") 19_i32,
                lateout("rcx") _,
                lateout("r11") _,
                out("xmm0") _,
                out("xmm1") _,
                out("xmm2") _,
                out("xmm3") _,
                out("xmm4") _,
                out("xmm5") _,
                out("xmm6") _,
                out("xmm7") _,
                out("xmm8") _,
                out("xmm9") _,
                out("xmm10") _,
                out("xmm11") _,
                out("xmm12") _,
                out("xmm13") _,
                out("xmm14") _,
                out("xmm15") _,
            );
        }
    }

    #[target_feature(enable = "avx")]
    unsafe fn fp_roundtrip_avx(pattern: *const u8, out: *mut u8, pid: i32) {
        unsafe {
            core::arch::asm!(
                "ldmxcsr [{p} + 0]",
                "vmovups ymm0, [{p} + 128]",
                "vmovups ymm1, [{p} + 192]",
                "vmovups ymm2, [{p} + 256]",
                "vmovups ymm3, [{p} + 320]",
                "vmovups ymm4, [{p} + 384]",
                "vmovups ymm5, [{p} + 448]",
                "vmovups ymm6, [{p} + 512]",
                "vmovups ymm7, [{p} + 576]",
                "vmovups ymm8, [{p} + 640]",
                "vmovups ymm9, [{p} + 704]",
                "vmovups ymm10, [{p} + 768]",
                "vmovups ymm11, [{p} + 832]",
                "vmovups ymm12, [{p} + 896]",
                "vmovups ymm13, [{p} + 960]",
                "vmovups ymm14, [{p} + 1024]",
                "vmovups ymm15, [{p} + 1088]",
                "fild qword ptr [{p} + 64]",
                "fild qword ptr [{p} + 72]",
                "fild qword ptr [{p} + 80]",
                "fild qword ptr [{p} + 88]",
                "fild qword ptr [{p} + 96]",
                "fild qword ptr [{p} + 104]",
                "fild qword ptr [{p} + 112]",
                "fild qword ptr [{p} + 120]",
                "syscall",
                "stmxcsr [{o} + 0]",
                "vmovups [{o} + 128], ymm0",
                "vmovups [{o} + 192], ymm1",
                "vmovups [{o} + 256], ymm2",
                "vmovups [{o} + 320], ymm3",
                "vmovups [{o} + 384], ymm4",
                "vmovups [{o} + 448], ymm5",
                "vmovups [{o} + 512], ymm6",
                "vmovups [{o} + 576], ymm7",
                "vmovups [{o} + 640], ymm8",
                "vmovups [{o} + 704], ymm9",
                "vmovups [{o} + 768], ymm10",
                "vmovups [{o} + 832], ymm11",
                "vmovups [{o} + 896], ymm12",
                "vmovups [{o} + 960], ymm13",
                "vmovups [{o} + 1024], ymm14",
                "vmovups [{o} + 1088], ymm15",
                "fistp qword ptr [{o} + 120]",
                "fistp qword ptr [{o} + 112]",
                "fistp qword ptr [{o} + 104]",
                "fistp qword ptr [{o} + 96]",
                "fistp qword ptr [{o} + 88]",
                "fistp qword ptr [{o} + 80]",
                "fistp qword ptr [{o} + 72]",
                "fistp qword ptr [{o} + 64]",
                p = in(reg) pattern,
                o = in(reg) out,
                inlateout("rax") 62_i64 => _,
                in("rdi") pid,
                in("rsi") 19_i32,
                lateout("rcx") _,
                lateout("r11") _,
                out("ymm0") _,
                out("ymm1") _,
                out("ymm2") _,
                out("ymm3") _,
                out("ymm4") _,
                out("ymm5") _,
                out("ymm6") _,
                out("ymm7") _,
                out("ymm8") _,
                out("ymm9") _,
                out("ymm10") _,
                out("ymm11") _,
                out("ymm12") _,
                out("ymm13") _,
                out("ymm14") _,
                out("ymm15") _,
            );
        }
    }

    #[target_feature(enable = "avx512f,avx512bw")]
    unsafe fn fp_roundtrip_avx512(pattern: *const u8, out: *mut u8, pid: i32) {
        unsafe {
            core::arch::asm!(
                "ldmxcsr [{p} + 0]",
                "vmovups zmm0, [{p} + 128]",
                "vmovups zmm1, [{p} + 192]",
                "vmovups zmm2, [{p} + 256]",
                "vmovups zmm3, [{p} + 320]",
                "vmovups zmm4, [{p} + 384]",
                "vmovups zmm5, [{p} + 448]",
                "vmovups zmm6, [{p} + 512]",
                "vmovups zmm7, [{p} + 576]",
                "vmovups zmm8, [{p} + 640]",
                "vmovups zmm9, [{p} + 704]",
                "vmovups zmm10, [{p} + 768]",
                "vmovups zmm11, [{p} + 832]",
                "vmovups zmm12, [{p} + 896]",
                "vmovups zmm13, [{p} + 960]",
                "vmovups zmm14, [{p} + 1024]",
                "vmovups zmm15, [{p} + 1088]",
                "vmovups zmm16, [{p} + 1152]",
                "vmovups zmm17, [{p} + 1216]",
                "vmovups zmm18, [{p} + 1280]",
                "vmovups zmm19, [{p} + 1344]",
                "vmovups zmm20, [{p} + 1408]",
                "vmovups zmm21, [{p} + 1472]",
                "vmovups zmm22, [{p} + 1536]",
                "vmovups zmm23, [{p} + 1600]",
                "vmovups zmm24, [{p} + 1664]",
                "vmovups zmm25, [{p} + 1728]",
                "vmovups zmm26, [{p} + 1792]",
                "vmovups zmm27, [{p} + 1856]",
                "vmovups zmm28, [{p} + 1920]",
                "vmovups zmm29, [{p} + 1984]",
                "vmovups zmm30, [{p} + 2048]",
                "vmovups zmm31, [{p} + 2112]",
                "kmovq k0, qword ptr [{p} + 2176]",
                "kmovq k1, qword ptr [{p} + 2184]",
                "kmovq k2, qword ptr [{p} + 2192]",
                "kmovq k3, qword ptr [{p} + 2200]",
                "kmovq k4, qword ptr [{p} + 2208]",
                "kmovq k5, qword ptr [{p} + 2216]",
                "kmovq k6, qword ptr [{p} + 2224]",
                "kmovq k7, qword ptr [{p} + 2232]",
                "fild qword ptr [{p} + 64]",
                "fild qword ptr [{p} + 72]",
                "fild qword ptr [{p} + 80]",
                "fild qword ptr [{p} + 88]",
                "fild qword ptr [{p} + 96]",
                "fild qword ptr [{p} + 104]",
                "fild qword ptr [{p} + 112]",
                "fild qword ptr [{p} + 120]",
                "syscall",
                "stmxcsr [{o} + 0]",
                "vmovups [{o} + 128], zmm0",
                "vmovups [{o} + 192], zmm1",
                "vmovups [{o} + 256], zmm2",
                "vmovups [{o} + 320], zmm3",
                "vmovups [{o} + 384], zmm4",
                "vmovups [{o} + 448], zmm5",
                "vmovups [{o} + 512], zmm6",
                "vmovups [{o} + 576], zmm7",
                "vmovups [{o} + 640], zmm8",
                "vmovups [{o} + 704], zmm9",
                "vmovups [{o} + 768], zmm10",
                "vmovups [{o} + 832], zmm11",
                "vmovups [{o} + 896], zmm12",
                "vmovups [{o} + 960], zmm13",
                "vmovups [{o} + 1024], zmm14",
                "vmovups [{o} + 1088], zmm15",
                "vmovups [{o} + 1152], zmm16",
                "vmovups [{o} + 1216], zmm17",
                "vmovups [{o} + 1280], zmm18",
                "vmovups [{o} + 1344], zmm19",
                "vmovups [{o} + 1408], zmm20",
                "vmovups [{o} + 1472], zmm21",
                "vmovups [{o} + 1536], zmm22",
                "vmovups [{o} + 1600], zmm23",
                "vmovups [{o} + 1664], zmm24",
                "vmovups [{o} + 1728], zmm25",
                "vmovups [{o} + 1792], zmm26",
                "vmovups [{o} + 1856], zmm27",
                "vmovups [{o} + 1920], zmm28",
                "vmovups [{o} + 1984], zmm29",
                "vmovups [{o} + 2048], zmm30",
                "vmovups [{o} + 2112], zmm31",
                "kmovq qword ptr [{o} + 2176], k0",
                "kmovq qword ptr [{o} + 2184], k1",
                "kmovq qword ptr [{o} + 2192], k2",
                "kmovq qword ptr [{o} + 2200], k3",
                "kmovq qword ptr [{o} + 2208], k4",
                "kmovq qword ptr [{o} + 2216], k5",
                "kmovq qword ptr [{o} + 2224], k6",
                "kmovq qword ptr [{o} + 2232], k7",
                "fistp qword ptr [{o} + 120]",
                "fistp qword ptr [{o} + 112]",
                "fistp qword ptr [{o} + 104]",
                "fistp qword ptr [{o} + 96]",
                "fistp qword ptr [{o} + 88]",
                "fistp qword ptr [{o} + 80]",
                "fistp qword ptr [{o} + 72]",
                "fistp qword ptr [{o} + 64]",
                p = in(reg) pattern,
                o = in(reg) out,
                inlateout("rax") 62_i64 => _,
                in("rdi") pid,
                in("rsi") 19_i32,
                lateout("rcx") _,
                lateout("r11") _,
                out("zmm0") _,
                out("zmm1") _,
                out("zmm2") _,
                out("zmm3") _,
                out("zmm4") _,
                out("zmm5") _,
                out("zmm6") _,
                out("zmm7") _,
                out("zmm8") _,
                out("zmm9") _,
                out("zmm10") _,
                out("zmm11") _,
                out("zmm12") _,
                out("zmm13") _,
                out("zmm14") _,
                out("zmm15") _,
                out("zmm16") _,
                out("zmm17") _,
                out("zmm18") _,
                out("zmm19") _,
                out("zmm20") _,
                out("zmm21") _,
                out("zmm22") _,
                out("zmm23") _,
                out("zmm24") _,
                out("zmm25") _,
                out("zmm26") _,
                out("zmm27") _,
                out("zmm28") _,
                out("zmm29") _,
                out("zmm30") _,
                out("zmm31") _,
                out("k0") _,
                out("k1") _,
                out("k2") _,
                out("k3") _,
                out("k4") _,
                out("k5") _,
                out("k6") _,
                out("k7") _,
            );
        }
    }

    fn fp_region_divergence(expected: &[u8], observed: &[u8], start: usize, len: usize) -> Option<usize> {
        (start..start + len).find(|at| expected[*at] != observed[*at])
    }

    /// First byte of the fixture the tier actually writes back that did not survive.
    /// Allocation-free: the leaf calls this after resuming and must not touch malloc.
    fn fp_first_divergence(tier: u8, expected: &[u8], observed: &[u8]) -> Option<usize> {
        let width = match tier {
            2 => 64,
            1 => 32,
            _ => 16,
        };
        if let Some(at) = fp_region_divergence(expected, observed, FP_MXCSR, 4) {
            return Some(at);
        }
        if let Some(at) = fp_region_divergence(expected, observed, FP_X87, 64) {
            return Some(at);
        }
        for slot in 0..16 {
            if let Some(at) = fp_region_divergence(expected, observed, FP_VEC + slot * 64, width) {
                return Some(at);
            }
        }
        if tier == 2 {
            for slot in 0..16 {
                if let Some(at) = fp_region_divergence(expected, observed, FP_VEC_HI16 + slot * 64, 64) {
                    return Some(at);
                }
            }
            if let Some(at) = fp_region_divergence(expected, observed, FP_KREG, 64) {
                return Some(at);
            }
        }
        None
    }

    unsafe fn fp_roundtrip(tier: u8, pattern: *const u8, out: *mut u8, pid: i32) {
        unsafe {
            match tier {
                2 => fp_roundtrip_avx512(pattern, out, pid),
                1 => fp_roundtrip_avx(pattern, out, pid),
                _ => fp_roundtrip_sse(pattern, out, pid),
            }
        }
    }

    fn fp_reset_mxcsr() {
        let default: u32 = 0x1f80;
        // SAFETY: `ldmxcsr` only reloads MXCSR from the supplied four-byte operand.
        unsafe { core::arch::asm!("ldmxcsr [{d}]", d = in(reg) &raw const default) };
    }

    // ---- allocation-free leaf plumbing -----------------------------------

    fn fp_hex_into(slot: &mut [u8], value: u64) {
        for (index, digit) in slot.iter_mut().rev().enumerate() {
            *digit = b"0123456789abcdef"[((value >> (4 * index)) & 0xf) as usize];
        }
    }

    fn fp_decimal_into(slot: &mut [u8], value: u64) {
        let mut rest = value;
        for digit in slot.iter_mut().rev() {
            *digit = b'0' + (rest % 10) as u8;
            rest /= 10;
        }
    }

    /// `<result>-<pid:08>.<suffix>` -- fixed width so the two spawns allocate
    /// identically, and so the leaf can patch the pid in without formatting.
    fn fp_keyed_path(result: &Path, pid: libc::pid_t, suffix: &str) -> PathBuf {
        let mut path = result.to_path_buf();
        let name = format!(
            "{}-{pid:08}.{suffix}",
            path.file_name().expect("result name").to_string_lossy()
        );
        path.set_file_name(name);
        path
    }

    /// The same path as a NUL-terminated byte buffer, plus the offset of the
    /// eight pid digits so the forked leaf can fill them in without allocating.
    fn fp_keyed_template(result: &Path, suffix: &str) -> (Vec<u8>, usize) {
        let path = fp_keyed_path(result, 0, suffix);
        let mut bytes = path.into_os_string().into_encoded_bytes();
        let digits_at = bytes.len() - suffix.len() - 9;
        debug_assert_eq!(&bytes[digits_at..digits_at + 8], b"00000000");
        bytes.push(0);
        (bytes, digits_at)
    }

    fn fp_write_file(path: &[u8], bytes: &[u8]) -> bool {
        // SAFETY: `path` is NUL terminated and `bytes` is a live slice for the call.
        unsafe {
            let fd = libc::open(
                path.as_ptr().cast(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
                0o600 as libc::c_uint,
            );
            if fd < 0 {
                return false;
            }
            let written = libc::write(fd, bytes.as_ptr().cast(), bytes.len());
            libc::close(fd);
            written == bytes.len() as isize
        }
    }

    /// Everything the forked leaf needs, reserved before the fork.
    struct FpLeafPlan {
        tier: u8,
        captured_role: bool,
        sentinel: u64,
        pattern: Vec<u8>,
        expected: Vec<u8>,
        observed: Vec<u8>,
        rendezvous: Vec<u8>,
        role_template: (Vec<u8>, usize),
        result_template: (Vec<u8>, usize),
        line: [u8; 43],
        stamp: [u8; 34],
    }

    static mut FP_SENTINEL: u64 = 0;

    /// Runs as the **thread group leader** of a freshly forked, single-threaded
    /// process.  That is deliberate: a libtest test body runs on a spawned
    /// thread, and the checkpoint path captures the leader, so a fixture that
    /// stopped itself on the test thread would have the parked main thread's
    /// registers captured instead.  The leaf must not allocate -- it forked out
    /// of a multi-threaded process and another thread may hold the malloc lock --
    /// so every buffer and path below was reserved before the fork.
    fn fp_leaf(mut plan: FpLeafPlan) -> ! {
        let pid = unsafe { libc::getpid() };
        fp_decimal_into(
            &mut plan.role_template.0[plan.role_template.1..plan.role_template.1 + 8],
            pid as u64,
        );
        fp_decimal_into(
            &mut plan.result_template.0[plan.result_template.1..plan.result_template.1 + 8],
            pid as u64,
        );
        // Trap 2, witnessed: record which fixture this incarnation is about to
        // load, before it stops, so the harness can prove the two roles differed.
        if !fp_write_file(
            &plan.role_template.0,
            if plan.captured_role { b"captured" } else { b"replaced" },
        ) {
            unsafe { libc::_exit(91) };
        }
        fp_hex_into(&mut plan.stamp[..16], pid as u64);
        plan.stamp[16] = b' ';
        fp_hex_into(&mut plan.stamp[17..33], plan.sentinel);
        plan.stamp[33] = b'\n';
        if !fp_write_file(&plan.rendezvous, &plan.stamp) {
            unsafe { libc::_exit(92) };
        }
        // Loads the fixture into the FP/vector file, group-stops with a raw
        // `SYS_kill` inside the same asm block so nothing can perturb the file
        // between the load and the stop, and spills it straight back out on resume.
        // SAFETY: both pointers address `FP_LEN` bytes that stay live for the call.
        unsafe { fp_roundtrip(plan.tier, plan.pattern.as_ptr(), plan.observed.as_mut_ptr(), pid) };
        fp_reset_mxcsr();
        let divergence = fp_first_divergence(plan.tier, &plan.expected, &plan.observed);
        let mxcsr = u32::from_le_bytes(plan.observed[FP_MXCSR..FP_MXCSR + 4].try_into().expect("mxcsr"));
        plan.line = *b"tier=0 div=0000000000000000 mxcsr=00000000\n";
        plan.line[5] = b'0' + plan.tier;
        fp_hex_into(&mut plan.line[11..27], divergence.map_or(u64::MAX, |at| at as u64));
        fp_hex_into(&mut plan.line[34..42], mxcsr as u64);
        let published = fp_write_file(&plan.result_template.0, &plan.line);
        unsafe {
            libc::_exit(if published {
                divergence.is_some() as libc::c_int
            } else {
                93
            })
        }
    }

    fn fp_restore_child() -> ! {
        let role =
            std::fs::read(std::env::var_os("HL_ENGINE_NATIVE_FPSTATE_ROLE").expect("role path")).expect("read role");
        let captured_role = role == b"captured";
        assert!(
            captured_role || role == b"replaced",
            "role file must carry one of the two equal-length roles"
        );
        let result = PathBuf::from(std::env::var_os("HL_ENGINE_NATIVE_FPSTATE_RESULT").expect("result path"));
        let mut rendezvous =
            PathBuf::from(std::env::var_os("HL_ENGINE_NATIVE_FPSTATE_RENDEZVOUS").expect("rendezvous path"))
                .into_os_string()
                .into_encoded_bytes();
        rendezvous.push(0);
        unsafe { std::ptr::write_volatile(&raw mut FP_SENTINEL, 0x5a71_cafe_9876_4321) };
        // Trap 2: the replacement deliberately loads a *different* non-default
        // pattern, so a restore that carries no FP state cannot pass by accident.
        let plan = FpLeafPlan {
            tier: fp_tier(),
            captured_role,
            sentinel: (&raw const FP_SENTINEL) as u64,
            pattern: if captured_role {
                fp_pattern(FP_SEED_CAPTURED, FP_MXCSR_PATTERN)
            } else {
                fp_pattern(FP_SEED_ANTI, FP_MXCSR_ANTI)
            },
            expected: fp_pattern(FP_SEED_CAPTURED, FP_MXCSR_PATTERN),
            observed: vec![0_u8; FP_LEN],
            rendezvous,
            role_template: fp_keyed_template(&result, "role"),
            result_template: fp_keyed_template(&result, "state"),
            line: [0; 43],
            stamp: [0; 34],
        };
        let leaf = unsafe { libc::fork() };
        assert!(leaf >= 0, "fork single-threaded leaf");
        if leaf == 0 {
            fp_leaf(plan);
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(leaf, &raw mut status, 0) }, leaf);
        std::fs::write(fp_keyed_path(&result, leaf, "status"), format!("{status:#010x}")).expect("publish status");
        std::process::exit(0);
    }

    fn spawn_fp_restore_child(test: &str, rendezvous: &Path, role: &Path, result: &Path) -> (Child, libc::pid_t, u64) {
        // argv and environment are identical for both spawns -- the role is
        // carried in a file whose two possible contents are the same length --
        // so the ASLR-disabled layout is reproduced byte for byte.
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args(["--exact", test, "--nocapture", "--test-threads=1"])
            .env("HL_ENGINE_NATIVE_FPSTATE_CHILD", "1")
            .env("HL_ENGINE_NATIVE_FPSTATE_RENDEZVOUS", rendezvous)
            .env("HL_ENGINE_NATIVE_FPSTATE_ROLE", role)
            .env("HL_ENGINE_NATIVE_FPSTATE_RESULT", result)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        unsafe {
            command.pre_exec(|| {
                let current = libc::personality(!0_u64 as libc::c_ulong);
                if current < 0
                    || libc::personality((current as libc::c_ulong) | libc::ADDR_NO_RANDOMIZE as libc::c_ulong) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().expect("spawn fp-state restore child");
        let deadline = Instant::now() + Duration::from_secs(10);
        let (leaf, address) = loop {
            if let Ok(value) = std::fs::read_to_string(rendezvous)
                && let Some((leaf, address)) = value.trim().split_once(' ')
                && let Ok(leaf) = i64::from_str_radix(leaf.trim(), 16)
                && let Ok(address) = u64::from_str_radix(address.trim(), 16)
                && leaf > 0
            {
                break (leaf as libc::pid_t, address);
            }
            assert!(
                Instant::now() < deadline,
                "fp-state leaf did not publish its rendezvous stamp"
            );
            std::thread::yield_now();
        };
        wait_until_stopped(leaf);
        (child, leaf, address)
    }

    #[test]
    fn native_image_restores_fp_and_vector_state_after_the_original_is_reaped() {
        const TEST: &str = "runtime::execution::native_snapshot::tests::native_image_restores_fp_and_vector_state_after_the_original_is_reaped";
        if std::env::var_os("HL_ENGINE_NATIVE_FPSTATE_CHILD").is_some() {
            fp_restore_child();
        }
        let rendezvous = tempfile::NamedTempFile::new().unwrap();
        let role = tempfile::NamedTempFile::new().unwrap();
        let result = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(role.path(), b"captured").unwrap();
        let (mut original, original_leaf, original_address) =
            spawn_fp_restore_child(TEST, rendezvous.path(), role.path(), result.path());
        let image = capture_stopped_native(original_leaf, Instant::now() + Duration::from_secs(10)).unwrap();
        assert_eq!(unsafe { libc::kill(original_leaf, libc::SIGKILL) }, 0);
        // SIGKILL already terminates a group-stopped task, so this SIGCONT only
        // nudges the harness's blocking `waitpid` along -- and it races that
        // reap.  Once the real parent has collected the leaf the pid is gone, so
        // ESRCH here means the kill worked, not that anything went wrong.  The
        // sibling fresh-exec test kills without a SIGCONT for the same reason.
        if unsafe { libc::kill(original_leaf, libc::SIGCONT) } != 0 {
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH),
                "SIGCONT after SIGKILL may only fail because the leaf was already reaped"
            );
        }
        assert!(
            original.wait().unwrap().success(),
            "original harness must reap its leaf"
        );

        std::fs::write(rendezvous.path(), b"").unwrap();
        std::fs::write(role.path(), b"replaced").unwrap();
        let (mut replacement, replacement_leaf, replacement_address) =
            spawn_fp_restore_child(TEST, rendezvous.path(), role.path(), result.path());
        assert_ne!(replacement_leaf, original_leaf);
        assert_eq!(
            replacement_address, original_address,
            "ASLR-disabled fresh exec must reproduce layout"
        );
        // Trap 2, mechanically: the two incarnations must have loaded *different*
        // fixtures, or a "restored" FP file could simply be the stub's own.
        assert_eq!(
            std::fs::read_to_string(fp_keyed_path(result.path(), original_leaf, "role")).expect("original role"),
            "captured"
        );
        assert_eq!(
            std::fs::read_to_string(fp_keyed_path(result.path(), replacement_leaf, "role")).expect("replacement role"),
            "replaced"
        );

        // Cross-host refusal, end to end and before any mutation: an image whose
        // XSTATE_BV names a component this host does not enable must be refused
        // by name.  No second machine is needed -- the recorded feature mask is
        // mutated in the image instead.
        let foreign = {
            let mut record = X86XstateRecord::decode(&image.xstate).unwrap();
            let absent = (0..63)
                .find(|bit| host_xcr0().expect("host xcr0") & (1 << bit) == 0)
                .expect("a state component this host does not enable");
            let widened = record.xstate_bv() | 1 << absent;
            record.xcr0 |= 1 << absent;
            record.area[XSTATE_BV_AT..XSTATE_BV_AT + 8].copy_from_slice(&widened.to_le_bytes());
            record.encode()
        };
        let refusal_pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, replacement_leaf, 0) } as RawFd;
        assert!(refusal_pidfd >= 0, "pidfd_open for the refusal probe");
        let refusal = prepare_native_restore(
            replacement_leaf,
            unsafe { OwnedFd::from_raw_fd(refusal_pidfd) },
            &image.registers,
            &image.memory,
            &foreign,
            Instant::now() + Duration::from_secs(10),
        )
        .err()
        .expect("a foreign feature mask must be refused, not restored");
        assert_eq!(refusal.kind(), io::ErrorKind::Unsupported);
        assert_eq!(refusal.to_string(), "native xstate host mismatch: Features");
        wait_until_stopped(replacement_leaf);

        let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, replacement_leaf, 0) } as RawFd;
        assert!(pidfd >= 0, "pidfd_open replacement leaf");
        let prepared = prepare_native_restore(
            replacement_leaf,
            unsafe { OwnedFd::from_raw_fd(pidfd) },
            &image.registers,
            &image.memory,
            &image.xstate,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        complete_native_restore(prepared, Instant::now() + Duration::from_secs(10)).unwrap();
        assert_eq!(unsafe { libc::kill(replacement_leaf, libc::SIGCONT) }, 0);
        assert!(
            replacement.wait().unwrap().success(),
            "replacement harness must reap its leaf"
        );

        let status = std::fs::read_to_string(fp_keyed_path(result.path(), replacement_leaf, "status"))
            .expect("harness must publish the leaf wait status");
        // The restored leaf runs on the original's memory, so it publishes under
        // the *original* leaf's key -- which is itself evidence the image landed.
        let report = std::fs::read_to_string(fp_keyed_path(result.path(), original_leaf, "state"))
            .unwrap_or_else(|error| panic!("restored leaf published no report (status={status}): {error}"));
        eprintln!("native fp/vector restore: {} status={status}", report.trim());

        // Trap 3: prove the CPU-feature gate actually ran, and that the tier the
        // leaf exercised is the one this box supports -- a cpuid helper silently
        // returning zero would disagree with the parent's own detection here.
        let tier: u8 = report
            .split_whitespace()
            .find_map(|field| field.strip_prefix("tier="))
            .and_then(|value| value.parse().ok())
            .expect("leaf must report the tier it exercised");
        assert_eq!(tier, fp_tier(), "leaf and harness must agree on the CPU-feature gate");
        eprintln!("native fp/vector tiers exercised: {}", fp_tier_names(tier));
        assert!(
            fp_tier_names(tier).starts_with("sse"),
            "the SSE tier must always be exercised"
        );
        let divergence = report
            .split_whitespace()
            .find_map(|field| field.strip_prefix("div="))
            .and_then(|value| u64::from_str_radix(value, 16).ok())
            .expect("leaf must report a divergence field");
        assert_eq!(
            (divergence, status.as_str()),
            (u64::MAX, "0x00000000"),
            "restored leaf must resume with the captured FP/vector state; report: {}",
            report.trim()
        );
    }

    #[test]
    fn object_and_commit_failures_abort_without_partial_publication_and_thaw_tracee() {
        for failure in [MEMORY_OBJECT, "commit"] {
            let pid = stopped_child();
            let sink = AtomicSink {
                fail_at: Some(failure),
                ..AtomicSink::default()
            };
            assert!(publish_stopped_native(&sink, pid, Instant::now() + Duration::from_secs(10)).is_err());
            let state = sink.state.lock().unwrap();
            assert!(state.0.is_empty());
            assert!(state.1.is_empty());
            assert_eq!(state.2, 1);
            drop(state);
            wait_until_running(pid);
            kill_and_reap(pid);
        }
    }

    #[test]
    fn begin_failure_still_thaws_the_tracee() {
        let pid = stopped_child();
        let sink = AtomicSink {
            begin_failure: true,
            ..AtomicSink::default()
        };
        assert_eq!(
            publish_stopped_native(&sink, pid, Instant::now() + Duration::from_secs(1)),
            Err(CompositionError::TransactionBusy)
        );
        wait_until_running(pid);
        kill_and_reap(pid);
    }

    #[test]
    fn expired_publication_uses_an_independent_abort_budget_and_releases_staging() {
        if isolated_live_capture(
            "runtime::execution::native_snapshot::tests::expired_publication_uses_an_independent_abort_budget_and_releases_staging",
        ) {
            return;
        }
        let pid = stopped_child();
        let sink = AtomicSink {
            expire_at: Some(MEMORY_OBJECT),
            ..AtomicSink::default()
        };
        assert_eq!(
            publish_stopped_native(&sink, pid, Instant::now() + Duration::from_secs(1)),
            Err(CompositionError::DeadlineExceeded)
        );
        let state = sink.state.lock().unwrap();
        assert!(state.0.is_empty());
        assert!(state.1.is_empty());
        assert_eq!(state.2, 1);
        drop(state);
        assert!(sink.begin_until(Instant::now() + Duration::from_secs(1)).is_ok());
        wait_until_running(pid);
        kill_and_reap(pid);
    }

    #[test]
    fn expired_register_deadline_does_not_attach_to_the_tracee() {
        let pid = stopped_child();
        let error = capture_until(pid, Instant::now() - Duration::from_millis(1)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
        assert!(status.lines().any(|line| line == "TracerPid:\t0"));
        unsafe { libc::kill(pid, libc::SIGCONT) };
        kill_and_reap(pid);
    }

    #[test]
    fn canonical_codec_is_exact_and_rejects_every_structural_mutation() {
        let record = X86RegisterRecord {
            signal_mask: 0x1122_3344_5566_7788,
            registers: std::array::from_fn(|index| 0xfeed_0000_0000_0000 | index as u64),
        };
        let encoded = record.encode();
        assert_eq!(&encoded[..8], b"HLNXREG\0");
        assert_eq!(&encoded[8..10], &2_u16.to_le_bytes());
        assert_eq!(&encoded[10..12], &62_u16.to_le_bytes());
        assert_eq!(&encoded[12..16], &256_u32.to_le_bytes());
        assert_eq!(X86RegisterRecord::decode(&encoded), Ok(record));
        for (at, expected) in [
            (0, InvalidRecord::Magic),
            (8, InvalidRecord::Version),
            (10, InvalidRecord::Architecture),
            (12, InvalidRecord::DeclaredSize),
            (24, InvalidRecord::Reserved),
            (255, InvalidRecord::Reserved),
        ] {
            let mut changed = encoded;
            changed[at] ^= 1;
            assert_eq!(X86RegisterRecord::decode(&changed), Err(expected), "offset {at}");
        }
        assert_eq!(X86RegisterRecord::decode(&encoded[..255]), Err(InvalidRecord::Size));
    }

    fn synthetic_xstate() -> X86XstateRecord {
        let mut area = vec![0_u8; XSTATE_MIN_AREA];
        for (index, byte) in area[..XSTATE_BV_AT].iter_mut().enumerate() {
            *byte = (index as u8).wrapping_mul(31) ^ 0x5a;
        }
        // x87 + SSE + AVX, and a non-default MXCSR in the legacy area.
        area[24..28].copy_from_slice(&0xdfc0_u32.to_le_bytes());
        area[XSTATE_BV_AT..XSTATE_BV_AT + 8].copy_from_slice(&0b111_u64.to_le_bytes());
        X86XstateRecord { xcr0: 0b111, area }
    }

    #[test]
    fn canonical_xstate_codec_is_exact_and_rejects_every_structural_mutation() {
        let record = synthetic_xstate();
        let encoded = record.encode();
        assert_eq!(encoded.len(), XSTATE_HEADER_SIZE + XSTATE_MIN_AREA);
        assert_eq!(&encoded[..8], b"HLNXXST\0");
        assert_eq!(&encoded[8..10], &2_u16.to_le_bytes());
        assert_eq!(&encoded[10..12], &62_u16.to_le_bytes());
        assert_eq!(&encoded[12..16], &(encoded.len() as u32).to_le_bytes());
        assert_eq!(&encoded[16..24], &0b111_u64.to_le_bytes());
        // The area is carried verbatim: no field of it is reconstructed.
        assert_eq!(&encoded[XSTATE_HEADER_SIZE..], &record.area[..]);
        assert_eq!(X86XstateRecord::decode(&encoded), Ok(record.clone()));

        for (at, expected) in [
            (0, InvalidXstateRecord::Magic),
            (8, InvalidXstateRecord::Version),
            (10, InvalidXstateRecord::Architecture),
            (12, InvalidXstateRecord::DeclaredSize),
            (24, InvalidXstateRecord::Reserved),
            (31, InvalidXstateRecord::Reserved),
            (16, InvalidXstateRecord::Components),
            (
                XSTATE_HEADER_SIZE + XSTATE_HEADER_RESERVED_AT,
                InvalidXstateRecord::HeaderReserved,
            ),
            (
                XSTATE_HEADER_SIZE + XSTATE_MIN_AREA - 1,
                InvalidXstateRecord::HeaderReserved,
            ),
        ] {
            let mut changed = encoded.clone();
            changed[at] ^= 1;
            assert_eq!(X86XstateRecord::decode(&changed), Err(expected), "offset {at}");
        }
        assert_eq!(
            X86XstateRecord::decode(&encoded[..encoded.len() - 1]),
            Err(InvalidXstateRecord::Size)
        );
        assert_eq!(
            X86XstateRecord::decode(&encoded[..XSTATE_HEADER_SIZE]),
            Err(InvalidXstateRecord::Size)
        );

        // XCOMP_BV is preserved exactly, never normalized away.
        let mut compacted = record.clone();
        compacted.area[XSTATE_XCOMP_BV_AT..XSTATE_XCOMP_BV_AT + 8]
            .copy_from_slice(&(XSTATE_COMPACTED_BIT | 0b111).to_le_bytes());
        assert!(compacted.compacted());
        assert_eq!(X86XstateRecord::decode(&compacted.encode()), Ok(compacted));
    }

    #[test]
    fn xstate_refuses_every_host_whose_layout_or_features_differ() {
        let local = synthetic_xstate();
        assert_eq!(local.admits(&local), Ok(()));

        // A component the restoring host does not enable: refuse, never drop it.
        let mut foreign = synthetic_xstate();
        foreign.xcr0 |= 1 << 17;
        foreign.area[XSTATE_BV_AT..XSTATE_BV_AT + 8].copy_from_slice(&(0b111_u64 | 1 << 17).to_le_bytes());
        assert_eq!(foreign.admits(&local), Err(XstateHostMismatch::Features));

        // Compacted versus standard layout: refuse, never re-lay-out.
        let mut compacted = synthetic_xstate();
        compacted.area[XSTATE_XCOMP_BV_AT..XSTATE_XCOMP_BV_AT + 8]
            .copy_from_slice(&(XSTATE_COMPACTED_BIT | 0b111).to_le_bytes());
        assert_eq!(compacted.admits(&local), Err(XstateHostMismatch::Layout));

        // A different area size means different component offsets: refuse,
        // never truncate and never zero fill.
        let mut wider = synthetic_xstate();
        wider.area.resize(XSTATE_MIN_AREA + 256, 0);
        assert_eq!(wider.admits(&local), Err(XstateHostMismatch::AreaSize));
        let mut narrower = synthetic_xstate();
        narrower.area.truncate(XSTATE_MIN_AREA);
        assert_eq!(narrower.admits(&wider), Err(XstateHostMismatch::AreaSize));
    }

    #[test]
    fn every_carrier_of_the_native_format_version_moves_together() {
        assert_eq!(VERSION, NATIVE_FORMAT_VERSION);
        assert_eq!(XSTATE_VERSION, NATIVE_FORMAT_VERSION);
        assert!(MANIFEST_MAGIC.ends_with(b"-V2\0"));
        for name in NATIVE_OBJECTS {
            assert!(name.ends_with("-v2"), "{name} must carry the format version");
        }
        assert_eq!(
            crate::runtime::checkpoint::image_envelope::NATIVE_X86_PAYLOAD_VERSION,
            u32::from(NATIVE_FORMAT_VERSION)
        );
        // A version-one manifest is still rejected byte for byte, which is the
        // only reason an image predating the xstate object cannot be half read.
        let mut stale = native_manifest(b"registers", b"memory", b"xstate");
        stale[..16].copy_from_slice(b"HLNATIVE-X86-V1\0");
        assert_eq!(
            validate_native_objects(&stale, |_| Some(Vec::new())),
            Err(InvalidNativeImage::Manifest)
        );
    }

    #[test]
    fn live_child_register_sentinel_and_signal_mask_are_captured_without_leaving_it_stopped() {
        let (pid, ready) = sentinel_child(false);
        wait_byte(ready);
        let state = capture(pid).unwrap();
        assert_eq!(state.registers.registers[0], 0x1515_1515_1515_1515, "r15 sentinel");
        assert_ne!(state.registers.signal_mask & (1 << (libc::SIGUSR1 - 1)), 0);
        assert!(state.xstate.area.len() >= XSTATE_MIN_AREA, "xstate area captured");
        wait_until_running(pid);
        kill_and_reap(pid);
    }

    #[test]
    fn failed_capture_thaws_running_child_and_preserves_an_existing_group_stop() {
        let (running, ready) = sentinel_child(false);
        wait_byte(ready);
        let error = capture_with(running, || Err(io::Error::other("injected after stop"))).unwrap_err();
        assert_eq!(error.to_string(), "injected after stop");
        wait_until_running(running);
        kill_and_reap(running);

        let (stopped, ready) = sentinel_child(true);
        wait_byte(ready);
        wait_until_stopped(stopped);
        capture(stopped).unwrap();
        wait_until_stopped(stopped);
        unsafe { libc::kill(stopped, libc::SIGCONT) };
        kill_and_reap(stopped);
    }

    #[test]
    fn exit_observation_does_not_reap_the_process_owners_child() {
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            unsafe { libc::_exit(23) }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match wait_for_ptrace_stop(pid, Duration::from_millis(10)) {
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(error) if error.raw_os_error() == Some(libc::ECHILD) && Instant::now() < deadline => {
                    std::thread::yield_now();
                }
                other => panic!("unexpected exit observation: {other:?}"),
            }
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &raw mut status, 0) }, pid);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 23);
    }

    #[test]
    fn seized_child_exit_is_observed_without_consuming_its_status() {
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            loop {
                unsafe { libc::pause() };
            }
        }
        ptrace(libc::PTRACE_SEIZE, pid, 0, 0).unwrap();
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        let error = wait_for_ptrace_stop(pid, Duration::from_secs(2)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(pid, &raw mut status, 0) }, pid);
        assert!(libc::WIFSIGNALED(status));
        assert_eq!(libc::WTERMSIG(status), libc::SIGKILL);
    }

    #[test]
    fn memory_codec_rejects_malformed_lengths_counts_and_overflow() {
        let image = NativeMemoryImage {
            mappings: vec![NativeMapping {
                start: 0x1000,
                end: 0x2000,
                offset: 0,
                protection: 3,
                device_major: 0,
                device_minor: 0,
                inode: 0,
                kernel_special: false,
                root_relative: None,
                file_digest: None,
                bytes: vec![0x5a; 0x1000],
            }],
        };
        let encoded = image.encode().unwrap();
        assert_eq!(NativeMemoryImage::decode(&encoded), Ok(image));
        for (at, value, expected) in [
            (0, b'X', InvalidMemoryImage::Magic),
            (8, 3, InvalidMemoryImage::Version),
            (10, 1, InvalidMemoryImage::Reserved),
            (24, 1, InvalidMemoryImage::Reserved),
            (MEMORY_HEADER_SIZE + 41, 2, InvalidMemoryImage::Kind),
        ] {
            let mut changed = encoded.clone();
            changed[at] = value;
            assert_eq!(NativeMemoryImage::decode(&changed), Err(expected));
        }
        let mut count = encoded.clone();
        count[12..16].copy_from_slice(&(MAX_MAPPINGS as u32 + 1).to_le_bytes());
        assert_eq!(NativeMemoryImage::decode(&count), Err(InvalidMemoryImage::Count));
        let mut overflow = encoded.clone();
        overflow[MEMORY_HEADER_SIZE + 52..MEMORY_HEADER_SIZE + 60].copy_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(NativeMemoryImage::decode(&overflow), Err(InvalidMemoryImage::Overflow));
        assert_eq!(
            NativeMemoryImage::decode(&encoded[..encoded.len() - 1]),
            Err(InvalidMemoryImage::Size)
        );
    }

    #[test]
    fn memory_codec_rejects_noncanonical_file_paths() {
        for path in [b"/absolute".as_slice(), b"a//b", b"a/./b", b"a/../b", b"a/\0b"] {
            let image = NativeMemoryImage {
                mappings: vec![NativeMapping {
                    start: 0x1000,
                    end: 0x2000,
                    offset: 0,
                    protection: 1,
                    device_major: 1,
                    device_minor: 2,
                    inode: 3,
                    kernel_special: false,
                    root_relative: Some(path.to_vec()),
                    file_digest: Some([7; 32]),
                    bytes: vec![],
                }],
            };
            assert_eq!(image.encode(), Err(InvalidMemoryImage::Path), "{path:?}");
        }
    }

    #[test]
    fn proc_maps_path_escapes_are_strict_and_canonical() {
        assert_eq!(decode_maps_path(br"a\040b\011c\012d\134e").unwrap(), b"a b\tc\nd\\e");
        for malformed in [br"a\".as_slice(), br"a\04", br"a\041", br"a\000"] {
            assert_eq!(
                decode_maps_path(malformed).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        }
    }

    #[test]
    fn mapped_file_digest_changes_with_the_mapped_range() {
        let file = tempfile::tempfile().unwrap();
        file.write_all_at(b"before", 0).unwrap();
        let first = hash_file_range(&file, 0, 6, Instant::now() + Duration::from_secs(1)).unwrap();
        file.write_all_at(b"after!", 0).unwrap();
        let second = hash_file_range(&file, 0, 6, Instant::now() + Duration::from_secs(1)).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn file_mapping_revalidation_rejects_in_place_content_change() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mapped file");
        std::fs::write(&path, b"before").unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let metadata = file.metadata().unwrap();
        let mapping = NativeMapping {
            start: 0x1000,
            end: 0x1006,
            offset: 0,
            protection: 1,
            device_major: libc::major(metadata.dev()) as u32,
            device_minor: libc::minor(metadata.dev()) as u32,
            inode: metadata.ino(),
            kernel_special: false,
            root_relative: Some(b"mapped file".to_vec()),
            file_digest: Some(hash_file_range(&file, 0, 6, Instant::now() + Duration::from_secs(1)).unwrap()),
            bytes: vec![],
        };
        std::fs::write(path, b"after!").unwrap();
        assert_eq!(
            revalidate_file_mappings(&[mapping], root.path(), Instant::now() + Duration::from_secs(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn stopped_child_prot_none_memory_is_captured_losslessly() {
        if isolated_live_capture(
            "runtime::execution::native_snapshot::tests::stopped_child_prot_none_memory_is_captured_losslessly",
        ) {
            return;
        }
        let mut pipe = [0; 2];
        assert_eq!(unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            unsafe {
                libc::close(pipe[0]);
                let page = libc::mmap(
                    std::ptr::null_mut(),
                    4096,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                    -1,
                    0,
                );
                assert_ne!(page, libc::MAP_FAILED);
                std::ptr::write_bytes(page.cast::<u8>(), 0x6e, 4096);
                assert_eq!(libc::mprotect(page, 4096, libc::PROT_NONE), 0);
                let address = page as u64;
                libc::write(pipe[1], (&raw const address).cast(), 8);
                libc::raise(libc::SIGSTOP);
                libc::pause();
            }
        }
        unsafe { libc::close(pipe[1]) };
        let mut address = 0u64;
        assert_eq!(unsafe { libc::read(pipe[0], (&raw mut address).cast(), 8) }, 8);
        unsafe { libc::close(pipe[0]) };
        wait_until_stopped(pid);
        let image = capture_stopped_memory(pid, Instant::now() + Duration::from_secs(2)).unwrap();
        assert_eq!(image_bytes(&image, address, 16), vec![0x6e; 16]);
        assert!(
            image
                .mappings
                .iter()
                .any(|mapping| mapping.start <= address && address < mapping.end && mapping.protection == 0)
        );
        kill_and_reap(pid);
    }

    #[test]
    fn stopped_child_heap_and_stack_are_captured_and_a_later_mutation_changes_only_the_new_image() {
        if isolated_live_capture(
            "runtime::execution::native_snapshot::tests::stopped_child_heap_and_stack_are_captured_and_a_later_mutation_changes_only_the_new_image",
        ) {
            return;
        }
        let (pid, ready) = memory_sentinel_child();
        let mut addresses = [0_u64; 2];
        assert_eq!(
            unsafe { libc::read(ready, addresses.as_mut_ptr().cast(), std::mem::size_of_val(&addresses)) },
            std::mem::size_of_val(&addresses) as isize
        );
        unsafe { libc::close(ready) };
        wait_until_stopped(pid);
        let first = capture_stopped_memory(pid, Instant::now() + Duration::from_secs(2)).unwrap();
        assert_eq!(image_bytes(&first, addresses[0], 16), vec![0x48; 16], "heap sentinel");
        assert_eq!(image_bytes(&first, addresses[1], 16), vec![0x53; 16], "stack sentinel");

        let replacement = [0x4d_u8; 16];
        let local = libc::iovec {
            iov_base: replacement.as_ptr().cast_mut().cast(),
            iov_len: replacement.len(),
        };
        let remote = libc::iovec {
            iov_base: addresses[0] as usize as *mut libc::c_void,
            iov_len: replacement.len(),
        };
        assert_eq!(
            unsafe { libc::process_vm_writev(pid, &raw const local, 1, &raw const remote, 1, 0) },
            16
        );
        let second = capture_stopped_memory(pid, Instant::now() + Duration::from_secs(2)).unwrap();
        assert_eq!(
            image_bytes(&first, addresses[0], 16),
            vec![0x48; 16],
            "first image mutated by alias"
        );
        assert_eq!(image_bytes(&second, addresses[0], 16), vec![0x4d; 16]);
        assert!(process_is_stopped(pid).unwrap(), "capture stole stop ownership");
        unsafe { libc::kill(pid, libc::SIGCONT) };
        kill_and_reap(pid);
    }

    #[test]
    fn stopped_capture_refuses_deadlines_and_running_targets_without_changing_ownership() {
        let (pid, ready) = sentinel_child(false);
        wait_byte(ready);
        let running = capture_stopped_memory(pid, Instant::now() + Duration::from_secs(1)).unwrap_err();
        assert_eq!(running.kind(), io::ErrorKind::InvalidInput);
        assert!(!process_is_stopped(pid).unwrap());
        unsafe { libc::kill(pid, libc::SIGSTOP) };
        wait_until_stopped(pid);
        let deadline = capture_stopped_memory(pid, Instant::now()).unwrap_err();
        assert_eq!(deadline.kind(), io::ErrorKind::TimedOut);
        assert!(process_is_stopped(pid).unwrap());
        unsafe { libc::kill(pid, libc::SIGCONT) };
        kill_and_reap(pid);
    }

    #[test]
    fn map_races_and_malformed_or_shared_tables_are_refused() {
        assert!(ensure_same_maps(b"one", b"one").is_ok());
        assert_eq!(
            ensure_same_maps(b"one", b"two").unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let root = Path::new("/");
        assert_eq!(
            parse_maps(b"not-a-map\n", root, Instant::now() + Duration::from_secs(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        let shared = b"1000-2000 rw-s 00000000 00:00 0\n";
        assert_eq!(
            parse_maps(shared, root, Instant::now() + Duration::from_secs(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::Unsupported
        );
    }

    fn image_bytes(image: &NativeMemoryImage, address: u64, length: usize) -> Vec<u8> {
        let mapping = image
            .mappings
            .iter()
            .find(|mapping| mapping.start <= address && address + length as u64 <= mapping.end)
            .expect("sentinel mapping");
        let offset = (address - mapping.start) as usize;
        mapping.bytes[offset..offset + length].to_vec()
    }

    fn memory_sentinel_child() -> (libc::pid_t, RawFd) {
        let mut pipe = [0; 2];
        assert_eq!(unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            unsafe {
                libc::close(pipe[0]);
                let heap = libc::malloc(16).cast::<u8>();
                assert!(!heap.is_null());
                std::ptr::write_bytes(heap, 0x48, 16);
                let stack = [0x53_u8; 16];
                let addresses = [heap as u64, stack.as_ptr() as u64];
                libc::write(pipe[1], addresses.as_ptr().cast(), std::mem::size_of_val(&addresses));
                libc::raise(libc::SIGSTOP);
                loop {
                    std::hint::black_box(std::ptr::read_volatile(heap));
                    std::hint::black_box(std::ptr::read_volatile(stack.as_ptr()));
                    libc::pause();
                }
            }
        }
        unsafe { libc::close(pipe[1]) };
        (pid, pipe[0])
    }

    fn sentinel_child(stop: bool) -> (libc::pid_t, RawFd) {
        let mut pipe = [0; 2];
        assert_eq!(unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            unsafe {
                libc::close(pipe[0]);
                let mut mask: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&raw mut mask);
                libc::sigaddset(&raw mut mask, libc::SIGUSR1);
                libc::sigprocmask(libc::SIG_BLOCK, &raw const mask, std::ptr::null_mut());
                std::arch::asm!("mov r15, {sentinel}", sentinel = in(reg) 0x1515_1515_1515_1515_u64);
                libc::write(pipe[1], b"R".as_ptr().cast(), 1);
                if stop {
                    libc::raise(libc::SIGSTOP);
                }
                loop {
                    libc::pause();
                }
            }
        }
        unsafe {
            libc::close(pipe[1]);
        }
        (pid, pipe[0])
    }

    fn wait_byte(fd: RawFd) {
        let mut byte = 0;
        assert_eq!(unsafe { libc::read(fd, (&raw mut byte as *mut u8).cast(), 1) }, 1);
        unsafe {
            libc::close(fd);
        }
    }

    fn wait_until_stopped(pid: libc::pid_t) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if process_is_stopped(pid).unwrap_or(false) {
                return;
            }
            std::thread::yield_now();
        }
        panic!("child {pid} did not stop");
    }

    fn wait_until_running(pid: libc::pid_t) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if !process_is_stopped(pid).unwrap_or(true) {
                let stable_until = Instant::now() + Duration::from_millis(50);
                while Instant::now() < stable_until {
                    assert!(!process_is_stopped(pid).unwrap(), "child {pid} stopped after detach");
                    std::thread::yield_now();
                }
                return;
            }
            std::thread::yield_now();
        }
        panic!("child {pid} did not resume");
    }

    fn kill_and_reap(pid: libc::pid_t) {
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
    }
}
