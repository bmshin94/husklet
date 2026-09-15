#![cfg(feature = "native-test-hooks")]

/// The hook emits real code and scans it, so it is answerable only where the emitters are compiled --
/// an `AArch64` host. Off it the hook reports `4`, "not applicable", and this fixture asserts that
/// rather than compiling itself out: the export still has to resolve, and the verdict that must never
/// appear on a host without the emitters is a clean `0`.
const CLEAN: i32 = if cfg!(target_arch = "aarch64") { 0 } else { 4 };

/// `rm_load` leaves a memory operand's effective address in host `x17` and `rm_store` stores through
/// it. The by-CL double shift used to park its masked shift count in `x17`, so every memory-destination
/// `shld`/`shrd %cl` stored the result to the count reinterpreted as a pointer -- a near-null store for
/// every addressing mode, every operand width and every count including zero, with the real destination
/// left stale. The immediate-count forms never touched `x17` and were always correct, so the fixture
/// spans both count forms: the one that broke and the one that has to keep working.
///
/// The hook emits every fixture twice, once per `HL_X86_RMLOAD_FOLD` shape, because the folded
/// `rm_load` addresses `[base,#imm]` directly and leaves no `x17` load to anchor a window scan on --
/// the option changes which lowering ships, not whether the reserved-register contract applies. The
/// flag is launch-scoped and read once, so the hook drives it in-process and fails if either shape is
/// wrong; a single verdict covers both.
#[test]
fn memory_destination_double_shifts_preserve_the_effective_address() {
    assert_eq!(hl_native::x86_double_shift_memory_ea_test(), CLEAN);
}
