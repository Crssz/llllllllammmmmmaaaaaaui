use std::sync::Mutex;

use serde::Serialize;
use sysinfo::System;
use tauri::State;

use crate::util::lock_or_poisoned;

// ── WMI GPU performance counters (Windows) ─────────────────────────────────
// Vendor-neutral utilization via the same perf counters Task Manager uses.
// Provides util% only — no temp/power/clocks.
#[cfg(windows)]
mod gpu_perf {
    use serde::Deserialize;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;
    use wmi::{COMLibrary, WMIConnection};

    #[derive(Deserialize, Debug)]
    #[serde(rename_all = "PascalCase")]
    struct GpuEngine {
        name: String,
        utilization_percentage: u64,
    }

    #[derive(Deserialize, Debug)]
    #[serde(rename_all = "PascalCase")]
    struct GpuAdapterMemory {
        name: String,
        dedicated_usage: u64,
    }

    /// Latest per-LUID telemetry, refreshed by a dedicated background thread.
    /// `util` is the highest engine utilization (%) per physical adapter;
    /// `mem_used` is dedicated VRAM in bytes per physical adapter — the global,
    /// all-process figure Task Manager labels "Dedicated GPU memory". See
    /// [`cache`] for why the sampling can't run inline.
    #[derive(Default, Clone)]
    struct Sample {
        util: HashMap<String, u32>,
        mem_used: HashMap<String, u64>,
    }
    type Cache = Arc<Mutex<Sample>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();

    /// How often the background thread re-queries WMI.
    const SAMPLE_INTERVAL: Duration = Duration::from_millis(1000);

    /// Returns the most recent map of LUID-token → highest engine utilization
    /// (%) for each physical adapter. The first call spawns the background
    /// sampler and returns an empty map until the first sample lands; every
    /// later call returns instantly from cache.
    ///
    /// Sampling happens on a dedicated thread, not inline, because WMI requires
    /// a multithreaded (MTA) COM apartment. `hw_snapshot` is a *synchronous*
    /// Tauri command, so it runs on the STA main thread — there
    /// `CoInitializeEx(COINIT_MULTITHREADED)` fails with `RPC_E_CHANGED_MODE`
    /// and the query returns nothing, which is what left GPU utilization frozen
    /// at "—". A dedicated thread owns its own MTA apartment, sidestepping the
    /// conflict, and keeps the (~hundreds-of-ms) query off the UI thread.
    pub fn query_util_by_luid() -> HashMap<String, u32> {
        cache().lock().map(|s| s.util.clone()).unwrap_or_default()
    }

    /// Per-LUID dedicated VRAM usage in bytes, from the WDDM "GPU Adapter
    /// Memory" perf counter — the same global, all-process figure Task Manager
    /// reports. Unlike HIP's `hipMemGetInfo`, which under WDDM only sees the
    /// calling process's own context, this reflects VRAM a *separate*
    /// llama-server holds, so the readout tracks a loaded model. Empty until
    /// the first sample lands or if the perf counter is unavailable.
    pub fn query_mem_used_by_luid() -> HashMap<String, u64> {
        cache()
            .lock()
            .map(|s| s.mem_used.clone())
            .unwrap_or_default()
    }

    fn cache() -> &'static Cache {
        CACHE.get_or_init(|| {
            let cache: Cache = Arc::new(Mutex::new(Sample::default()));
            let worker = Arc::clone(&cache);
            let spawned = std::thread::Builder::new()
                .name("gpu-telemetry-wmi".into())
                .spawn(move || sampler_loop(worker));
            if let Err(e) = spawned {
                log::warn!("wmi: failed to spawn GPU telemetry sampler: {e}");
            }
            cache
        })
    }

    /// Owns an MTA apartment + WMI connection for the process lifetime and
    /// refreshes the shared cache every [`SAMPLE_INTERVAL`].
    fn sampler_loop(cache: Cache) {
        let wmi = match COMLibrary::new().and_then(WMIConnection::new) {
            Ok(w) => w,
            Err(e) => {
                // No MTA / WMI here means no utilization or VRAM-usage readings
                // this session (e.g. the WMI service is disabled). VRAM total
                // via HIP still works; usage falls back to HIP's own context.
                log::debug!("wmi: GPU telemetry sampler init failed: {e}");
                return;
            }
        };
        loop {
            let sample = Sample {
                util: query_util_once(&wmi),
                mem_used: query_mem_once(&wmi),
            };
            if let Ok(mut guard) = cache.lock() {
                *guard = sample;
            }
            std::thread::sleep(SAMPLE_INTERVAL);
        }
    }

    /// Runs the engine perf-counter query once and folds it to a per-adapter
    /// maximum utilization.
    fn query_util_once(wmi: &WMIConnection) -> HashMap<String, u32> {
        let rows: Vec<GpuEngine> = match wmi.raw_query(
            "SELECT Name, UtilizationPercentage \
             FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine",
        ) {
            Ok(r) => r,
            Err(e) => {
                log::debug!("wmi: GPUEngine query failed: {e}");
                return HashMap::new();
            }
        };
        let mut by_luid: HashMap<String, u32> = HashMap::new();
        for row in rows {
            // Name format: "pid_XXXX_luid_0xXXXXXXXX_0xXXXXXXXX_phys_X_eng_X_engtype_3D"
            // Group by the LUID portion (which identifies a physical adapter).
            if let Some(luid) = extract_luid(&row.name) {
                let entry = by_luid.entry(luid).or_insert(0);
                let v = row.utilization_percentage as u32;
                if v > *entry {
                    *entry = v;
                }
            }
        }
        by_luid
    }

    /// Runs the adapter-memory perf-counter query once and sums dedicated VRAM
    /// usage (bytes) per physical adapter. Instances are per-adapter
    /// (`luid_..._phys_N`), not per-process, so the value already aggregates
    /// every process's allocations on that card — including a model held by a
    /// separate llama-server, which HIP's per-process view can't see.
    fn query_mem_once(wmi: &WMIConnection) -> HashMap<String, u64> {
        let rows: Vec<GpuAdapterMemory> = match wmi.raw_query(
            "SELECT Name, DedicatedUsage \
             FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory",
        ) {
            Ok(r) => r,
            Err(e) => {
                log::debug!("wmi: GPUAdapterMemory query failed: {e}");
                return HashMap::new();
            }
        };
        let mut by_luid: HashMap<String, u64> = HashMap::new();
        for row in rows {
            // Name format: "luid_0xXXXXXXXX_0xXXXXXXXX_phys_X" — already
            // per-adapter, so reuse extract_luid and sum across phys indices.
            if let Some(luid) = extract_luid(&row.name) {
                *by_luid.entry(luid).or_insert(0) += row.dedicated_usage;
            }
        }
        by_luid
    }

    pub fn extract_luid(name: &str) -> Option<String> {
        let start = name.find("luid_")?;
        let rest = &name[start..];
        let end = rest.find("_phys_").unwrap_or(rest.len());
        Some(rest[..end].to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn extract_luid_handles_typical_name() {
            let s = "pid_1234_luid_0x00000000_0x0000ABCD_phys_0_eng_3_engtype_3D";
            assert_eq!(
                extract_luid(s).as_deref(),
                Some("luid_0x00000000_0x0000ABCD")
            );
        }

        #[test]
        fn extract_luid_none_for_unrelated_string() {
            assert!(extract_luid("nothing here").is_none());
        }

        #[test]
        fn extract_luid_handles_adapter_memory_name() {
            // GPU Adapter Memory instances are LUID-prefixed (no pid_), unlike
            // GPU Engine instances. extract_luid must handle both shapes so the
            // per-adapter VRAM usage joins with utilization by the same token.
            let s = "luid_0x00000000_0x0001D34E_phys_0";
            assert_eq!(
                extract_luid(s).as_deref(),
                Some("luid_0x00000000_0x0001D34E")
            );
        }

        // Regression guard: GPU utilization once sat frozen at "—" because the
        // synchronous `hw_snapshot` command runs on Tauri's STA main thread,
        // where the wmi crate's MTA `CoInitializeEx` fails. The sampler must
        // therefore run on its own thread. This pins both halves of that fact.
        #[test]
        fn wmi_mta_init_fails_on_sta_but_works_on_a_worker_thread() {
            use windows::Win32::System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
            };
            let (sta_failed, worker_ok) = std::thread::spawn(|| {
                // Stand in for the STA main thread the command actually runs on.
                unsafe {
                    CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                        .ok()
                        .expect("STA init");
                }
                // wmi forces COINIT_MULTITHREADED → RPC_E_CHANGED_MODE here.
                let sta_failed = COMLibrary::without_security().is_err();
                // A dedicated worker owns a fresh MTA apartment → succeeds.
                let worker_ok = std::thread::spawn(|| COMLibrary::without_security().is_ok())
                    .join()
                    .unwrap_or(false);
                unsafe { CoUninitialize() };
                (sta_failed, worker_ok)
            })
            .join()
            .unwrap();

            assert!(sta_failed, "WMI MTA init must fail on the STA main thread");
            assert!(
                worker_ok,
                "WMI MTA init must succeed on a dedicated worker thread"
            );
        }

        // Manual smoke test — needs a real GPU exposing WMI engine counters, so
        // it's ignored by default. Run with:
        //   cargo test --lib gpu_perf -- --ignored --nocapture
        #[test]
        #[ignore = "requires a GPU with WMI engine counters"]
        fn sampler_populates_live_utilization() {
            // First call spawns the sampler; cache is empty until it warms up.
            assert!(query_util_by_luid().is_empty());
            for i in 0..3 {
                std::thread::sleep(Duration::from_millis(1200));
                let util = query_util_by_luid();
                let mem = query_mem_used_by_luid();
                let mem_gb: std::collections::HashMap<_, _> = mem
                    .iter()
                    .map(|(k, v)| (k.clone(), *v as f64 / 1024.0 / 1024.0 / 1024.0))
                    .collect();
                println!("sample {i}: util={util:?}");
                println!("sample {i}: mem_gb={mem_gb:?}");
            }
            assert!(
                !query_util_by_luid().is_empty(),
                "sampler should have populated per-LUID utilization by now"
            );
            assert!(
                !query_mem_used_by_luid().is_empty(),
                "sampler should have populated per-LUID dedicated VRAM usage"
            );
        }
    }
}

// ── HIP runtime (AMD) ───────────────────────────────────────────────────────
// Dynamically loads amdhip64_7.dll (or older variants) for AMD GPU detection.
// Only used as a fallback when NVML reports zero NVIDIA devices.
#[cfg(windows)]
pub mod hip {
    use libloading::{Library, Symbol};
    use std::ffi::{c_char, CStr};
    use std::path::Path;

    pub type HipError = i32;
    pub type HipDevice = i32;
    const HIP_SUCCESS: HipError = 0;

    pub struct HipRuntime {
        _lib: Library,
        get_device_count: unsafe extern "C" fn(count: *mut i32) -> HipError,
        device_get_name:
            unsafe extern "C" fn(name: *mut c_char, len: i32, device: HipDevice) -> HipError,
        device_total_mem: unsafe extern "C" fn(total: *mut usize, device: HipDevice) -> HipError,
        set_device: unsafe extern "C" fn(device: HipDevice) -> HipError,
        mem_get_info: unsafe extern "C" fn(free: *mut usize, total: *mut usize) -> HipError,
    }

    // libloading::Library on Windows uses LoadLibrary, which is thread-safe.
    // Function pointers are inherently Send+Sync. Mark explicitly so we can
    // wrap in Arc<Mutex<...>>.
    unsafe impl Send for HipRuntime {}
    unsafe impl Sync for HipRuntime {}

    pub struct DeviceInfo {
        pub name: String,
        pub vram_total: usize,
        pub vram_free: usize,
    }

    impl HipRuntime {
        const DLL_NAMES: &'static [&'static str] =
            &["amdhip64_7.dll", "amdhip64_6.dll", "amdhip64.dll"];

        pub fn try_open(search_dirs: &[&Path]) -> Option<Self> {
            let mut lib: Option<Library> = None;
            for name in Self::DLL_NAMES {
                // Try system PATH first
                unsafe {
                    if let Ok(l) = Library::new(name) {
                        log::info!("hip: loaded {name} from system PATH");
                        lib = Some(l);
                        break;
                    }
                }
                for d in search_dirs {
                    let p = d.join(name);
                    if p.is_file() {
                        unsafe {
                            match Library::new(&p) {
                                Ok(l) => {
                                    log::info!("hip: loaded {}", p.display());
                                    lib = Some(l);
                                    break;
                                }
                                Err(e) => log::warn!("hip: failed to load {}: {e}", p.display()),
                            }
                        }
                    }
                }
                if lib.is_some() {
                    break;
                }
            }
            let lib = lib?;
            unsafe {
                let s_get_device_count: Symbol<unsafe extern "C" fn(*mut i32) -> HipError> =
                    lib.get(b"hipGetDeviceCount\0").ok()?;
                let s_device_get_name: Symbol<
                    unsafe extern "C" fn(*mut c_char, i32, HipDevice) -> HipError,
                > = lib.get(b"hipDeviceGetName\0").ok()?;
                let s_device_total_mem: Symbol<
                    unsafe extern "C" fn(*mut usize, HipDevice) -> HipError,
                > = lib.get(b"hipDeviceTotalMem\0").ok()?;
                let s_set_device: Symbol<unsafe extern "C" fn(HipDevice) -> HipError> =
                    lib.get(b"hipSetDevice\0").ok()?;
                let s_mem_get_info: Symbol<
                    unsafe extern "C" fn(*mut usize, *mut usize) -> HipError,
                > = lib.get(b"hipMemGetInfo\0").ok()?;

                let get_device_count = *s_get_device_count;
                let device_get_name = *s_device_get_name;
                let device_total_mem = *s_device_total_mem;
                let set_device = *s_set_device;
                let mem_get_info = *s_mem_get_info;

                // Optional: hipInit(0). Some runtimes auto-init; we tolerate
                // either presence or absence.
                if let Ok(init) = lib.get::<unsafe extern "C" fn(u32) -> HipError>(b"hipInit\0") {
                    let rc = init(0);
                    if rc != HIP_SUCCESS {
                        log::warn!("hip: hipInit returned {rc} (continuing)");
                    }
                }

                Some(HipRuntime {
                    _lib: lib,
                    get_device_count,
                    device_get_name,
                    device_total_mem,
                    set_device,
                    mem_get_info,
                })
            }
        }

        pub fn device_count(&self) -> i32 {
            let mut n: i32 = 0;
            unsafe {
                if (self.get_device_count)(&mut n) == HIP_SUCCESS {
                    n.max(0)
                } else {
                    0
                }
            }
        }

        pub fn device_info(&self, idx: HipDevice) -> Option<DeviceInfo> {
            let mut name_buf = [0u8; 256];
            unsafe {
                let rc = (self.device_get_name)(
                    name_buf.as_mut_ptr() as *mut c_char,
                    name_buf.len() as i32,
                    idx,
                );
                if rc != HIP_SUCCESS {
                    return None;
                }
                let name = CStr::from_ptr(name_buf.as_ptr() as *const c_char)
                    .to_string_lossy()
                    .into_owned();

                let mut total: usize = 0;
                let _ = (self.device_total_mem)(&mut total, idx);

                let mut free: usize = 0;
                if (self.set_device)(idx) == HIP_SUCCESS {
                    let mut free_buf: usize = 0;
                    let mut total_buf: usize = 0;
                    if (self.mem_get_info)(&mut free_buf, &mut total_buf) == HIP_SUCCESS {
                        free = free_buf;
                        if total == 0 {
                            total = total_buf;
                        }
                    }
                }
                Some(DeviceInfo {
                    name,
                    vram_total: total,
                    vram_free: free,
                })
            }
        }
    }
}

// ── WDDM kernel telemetry (Windows) ──────────────────────────────────────────
// The D3DKMT graphics-kernel interface in gdi32.dll — the same source Task
// Manager reads. Unlike ADL/ADLX (display-oriented), it enumerates *every*
// adapter the kernel knows about, including headless compute GPUs, and reports
// temperature + engine clock. It does not expose power in watts (the Power
// field is a percentage of TDP and is frequently zero), so we read temp+clock
// only and leave power to a future amd-smi integration.
#[cfg(windows)]
mod kmt {
    use std::collections::HashMap;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Luid {
        low: u32,
        high: i32,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AdapterInfo {
        h_adapter: u32,
        luid: Luid,
        num_sources: u32,
        b_precise_present: i32,
    }
    #[repr(C)]
    struct EnumAdapters2 {
        num_adapters: u32,
        p_adapters: *mut AdapterInfo,
    }
    #[repr(C)]
    struct QueryAdapterInfo {
        h_adapter: u32,
        type_: i32,
        p_data: *mut std::ffi::c_void,
        data_size: u32,
    }
    // Layout must match d3dkmthk.h exactly; the kernel validates DataSize.
    #[repr(C)]
    #[derive(Default)]
    struct AdapterPerfData {
        physical_adapter_index: u32,
        memory_frequency: u64,
        max_memory_frequency: u64,
        max_memory_frequency_oc: u64,
        memory_bandwidth: u64,
        pcie_bandwidth: u64,
        fan_rpm: u32,
        power: u32,
        temperature: u32, // deci-Celsius (1 = 0.1 °C)
        power_state_override: u8,
    }
    #[repr(C)]
    #[derive(Default)]
    struct NodePerfData {
        node_ordinal: u32,
        physical_adapter_index: u32,
        frequency: u64, // engine clock in Hz
        max_frequency: u64,
        max_frequency_oc: u64,
        voltage: u32,
        voltage_max: u32,
        voltage_max_oc: u32,
        max_transition_latency: u64,
    }

    const KMTQAITYPE_NODEPERFDATA: i32 = 61;
    const KMTQAITYPE_ADAPTERPERFDATA: i32 = 62;

    // Documented as available in Gdi32.lib.
    #[link(name = "gdi32")]
    extern "system" {
        fn D3DKMTEnumAdapters2(p: *mut EnumAdapters2) -> i32;
        fn D3DKMTQueryAdapterInfo(p: *mut QueryAdapterInfo) -> i32;
    }

    #[derive(Clone, Copy, Default)]
    pub struct Telemetry {
        pub temp_c: Option<u32>,
        pub clock_mhz: Option<u32>,
    }

    /// Returns a map of LUID-token → temperature/clock for every adapter the
    /// WDDM kernel reports perf data for. The token is lowercase and matches
    /// the shape of [`gpu_perf::extract_luid`] (lowercased) so the two sources
    /// can be joined per physical adapter. Empty on any failure.
    pub fn query_by_luid() -> HashMap<String, Telemetry> {
        let mut out = HashMap::new();
        const CAP: usize = 16;
        let mut adapters = [AdapterInfo {
            h_adapter: 0,
            luid: Luid { low: 0, high: 0 },
            num_sources: 0,
            b_precise_present: 0,
        }; CAP];
        let mut e = EnumAdapters2 {
            num_adapters: CAP as u32,
            p_adapters: adapters.as_mut_ptr(),
        };
        // SAFETY: `adapters` outlives the call and is sized to `num_adapters`.
        if unsafe { D3DKMTEnumAdapters2(&mut e) } != 0 {
            return out;
        }
        let n = (e.num_adapters as usize).min(CAP);
        for a in &adapters[..n] {
            let mut pd = AdapterPerfData::default();
            let mut q = QueryAdapterInfo {
                h_adapter: a.h_adapter,
                type_: KMTQAITYPE_ADAPTERPERFDATA,
                p_data: &mut pd as *mut _ as *mut std::ffi::c_void,
                data_size: std::mem::size_of::<AdapterPerfData>() as u32,
            };
            // SAFETY: `pd` matches the kernel's struct and outlives the call.
            if unsafe { D3DKMTQueryAdapterInfo(&mut q) } != 0 {
                continue; // non-GPU / non-perf adapter (e.g. Basic Render)
            }
            let temp_c = (pd.temperature > 0).then_some(pd.temperature / 10);
            // Engine clock lives per-node; take the busiest node's frequency.
            let mut best_hz = 0u64;
            for node in 0..8u32 {
                let mut nd = NodePerfData {
                    node_ordinal: node,
                    ..Default::default()
                };
                let mut nq = QueryAdapterInfo {
                    h_adapter: a.h_adapter,
                    type_: KMTQAITYPE_NODEPERFDATA,
                    p_data: &mut nd as *mut _ as *mut std::ffi::c_void,
                    data_size: std::mem::size_of::<NodePerfData>() as u32,
                };
                // SAFETY: `nd` matches the kernel's struct and outlives the call.
                if unsafe { D3DKMTQueryAdapterInfo(&mut nq) } == 0 && nd.frequency > best_hz {
                    best_hz = nd.frequency;
                }
            }
            let clock_mhz = (best_hz > 0).then_some((best_hz / 1_000_000) as u32);
            let luid = format!("luid_0x{:08x}_0x{:08x}", a.luid.high as u32, a.luid.low);
            out.insert(luid, Telemetry { temp_c, clock_mhz });
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        // Manual smoke test — needs a real GPU. Run with:
        //   cargo test --lib kmt -- --ignored --nocapture
        #[test]
        #[ignore = "requires a GPU the WDDM kernel reports perf data for"]
        fn d3dkmt_reads_temperature_and_clock() {
            let map = query_by_luid();
            for (luid, t) in &map {
                println!("{luid}: temp={:?}C clock={:?}MHz", t.temp_c, t.clock_mhz);
            }
            assert!(
                map.values().any(|t| t.temp_c.is_some()),
                "expected at least one adapter to report a temperature"
            );
        }
    }
}

// ── Hardware snapshot ───────────────────────────────────────────────────────
#[derive(Debug, Serialize, Clone)]
pub struct GpuInfo {
    pub name: String,
    pub vram_total_gb: f64,
    pub vram_used_gb: f64,
    pub util: Option<u32>,
    pub temp_c: Option<u32>,
    pub power_w: Option<u32>,
    pub clock_mhz: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HwSnapshot {
    pub cpu_util: f32,
    pub cpu_name: String,
    pub cpu_cores: usize,
    pub cpu_freq_ghz: f32,
    pub ram_total_gb: f64,
    pub ram_used_gb: f64,
    pub swap_used_gb: f64,
    pub gpus: Vec<GpuInfo>,
    pub gpu_backend: &'static str,
}

pub struct HwState {
    pub sys: Mutex<System>,
    #[cfg(feature = "nvml")]
    pub nvml: std::sync::OnceLock<Option<nvml_wrapper::Nvml>>,
    #[cfg(windows)]
    pub hip: Mutex<Option<std::sync::Arc<hip::HipRuntime>>>,
    pub build_dir_hint: Mutex<Option<String>>,
}

#[tauri::command]
pub fn hw_snapshot(state: State<'_, HwState>) -> HwSnapshot {
    let mut sys = lock_or_poisoned(&state.sys);
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu_util = sys.global_cpu_usage();
    let cpus = sys.cpus();
    let cpu_name = cpus
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_default();
    let cpu_freq_ghz = cpus
        .first()
        .map(|c| c.frequency() as f32 / 1000.0)
        .unwrap_or(0.0);
    let cpu_cores = cpus.len();
    let ram_total_gb = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let ram_used_gb = sys.used_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let swap_used_gb = sys.used_swap() as f64 / 1024.0 / 1024.0 / 1024.0;

    let (gpus, backend) = read_gpus(&state);

    HwSnapshot {
        cpu_util,
        cpu_name,
        cpu_cores,
        cpu_freq_ghz,
        ram_total_gb,
        ram_used_gb,
        swap_used_gb,
        gpus,
        gpu_backend: backend,
    }
}

fn read_gpus(state: &State<'_, HwState>) -> (Vec<GpuInfo>, &'static str) {
    // ── NVIDIA first (NVML) ────────────────────────────────────────────────
    #[cfg(feature = "nvml")]
    {
        let nvml_slot = state.nvml.get_or_init(|| nvml_wrapper::Nvml::init().ok());
        if let Some(nvml) = nvml_slot {
            let count = nvml.device_count().unwrap_or(0);
            let mut out = Vec::new();
            for i in 0..count {
                if let Ok(d) = nvml.device_by_index(i) {
                    let name = d.name().unwrap_or_else(|_| "GPU".into());
                    let mem = d.memory_info().ok();
                    let util = d.utilization_rates().ok();
                    let temp = d
                        .temperature(nvml_wrapper::enum_wrappers::device::TemperatureSensor::Gpu)
                        .ok();
                    let power = d.power_usage().ok().map(|w| w / 1000);
                    let clock = d
                        .clock_info(nvml_wrapper::enum_wrappers::device::Clock::Graphics)
                        .ok();
                    out.push(GpuInfo {
                        name,
                        vram_total_gb: mem
                            .as_ref()
                            .map(|m| m.total as f64 / 1024.0 / 1024.0 / 1024.0)
                            .unwrap_or(0.0),
                        vram_used_gb: mem
                            .as_ref()
                            .map(|m| m.used as f64 / 1024.0 / 1024.0 / 1024.0)
                            .unwrap_or(0.0),
                        util: util.map(|u| u.gpu),
                        temp_c: temp,
                        power_w: power,
                        clock_mhz: clock,
                    });
                }
            }
            if !out.is_empty() {
                return (out, "NVML");
            }
        }
    }

    // ── AMD via HIP (Windows only) ─────────────────────────────────────────
    #[cfg(windows)]
    {
        // Try to load the HIP runtime, caching the result on success. On
        // failure we leave the slot empty so a future call (after the user
        // points at a llama.cpp ROCm build) can retry.
        let hint = lock_or_poisoned(&state.build_dir_hint).clone();
        let hip_arc: Option<std::sync::Arc<hip::HipRuntime>> = {
            let mut slot = lock_or_poisoned(&state.hip);
            if slot.is_none() {
                let dirs: Vec<std::path::PathBuf> = hint
                    .as_ref()
                    .map(|s| {
                        let p = std::path::PathBuf::from(s);
                        vec![
                            p.clone(),
                            p.join("bin"),
                            p.join("bin/Release"),
                            p.join("Release"),
                        ]
                    })
                    .unwrap_or_default();
                let dir_refs: Vec<&std::path::Path> = dirs.iter().map(|p| p.as_path()).collect();
                if let Some(rt) = hip::HipRuntime::try_open(&dir_refs) {
                    *slot = Some(std::sync::Arc::new(rt));
                }
            }
            slot.clone()
        };

        if let Some(hip) = hip_arc {
            let count = hip.device_count();
            let mut out = Vec::new();
            for i in 0..count {
                if let Some(info) = hip.device_info(i) {
                    let used = info.vram_total.saturating_sub(info.vram_free);
                    out.push(GpuInfo {
                        name: info.name,
                        vram_total_gb: info.vram_total as f64 / 1024.0 / 1024.0 / 1024.0,
                        vram_used_gb: used as f64 / 1024.0 / 1024.0 / 1024.0,
                        // HIP runtime alone can't tell us these. WMI fills
                        // util below; temp/power/clock need ROCm-SMI or ADLX.
                        util: None,
                        temp_c: None,
                        power_w: None,
                        clock_mhz: None,
                    });
                }
            }

            if !out.is_empty() {
                // Layer in per-adapter telemetry the HIP runtime can't provide
                // (utilization, dedicated VRAM usage, temperature, clock),
                // joined by LUID. See `merge_gpu_telemetry` for the details.
                let (have_wmi, have_kmt) = merge_gpu_telemetry(
                    &mut out,
                    &gpu_perf::query_util_by_luid(),
                    &kmt::query_by_luid(),
                    &gpu_perf::query_mem_used_by_luid(),
                );
                let label: &'static str = match (have_wmi, have_kmt) {
                    (true, true) => "HIP + WMI + WDDM",
                    (true, false) => "HIP + WMI",
                    (false, true) => "HIP + WDDM",
                    (false, false) => "HIP",
                };
                return (out, label);
            }
        }
    }

    (vec![], "unavailable")
}

/// Merges per-LUID telemetry onto the HIP-detected `gpus`, in place, and
/// returns `(have_wmi, have_kmt)` for backend labeling.
///
/// Each card's records are joined by LUID token: utilization and dedicated
/// VRAM usage from the WMI perf counters (`util_map`/`mem_map`), temperature +
/// engine clock from the D3DKMT kernel interface (`kmt_map`). VRAM usage comes
/// from WMI rather than HIP because HIP's `hipMemGetInfo` reports only this
/// process's context under WDDM, not a model a separate llama-server loads, so
/// it overwrites HIP's per-process baseline already on each `GpuInfo`.
///
/// Adapters are ordered by LUID — the stable per-boot ID the system enumerates
/// by, the same fixed numbering Task Manager uses — never by load, so a card
/// keeps its GPU 0/1 slot as utilization changes. Software adapters (the
/// "Microsoft Basic Render Driver" / WARP, which surface in the WMI counters
/// but have no kernel perf data) are dropped, unless no adapter has kernel perf
/// data at all, in which case every record is kept so WMI utilization still
/// shows. We still can't tie a LUID to a specific HIP device index, so among
/// identical cards the slot↔card pairing follows LUID order; single-GPU is
/// exact.
#[cfg(windows)]
fn merge_gpu_telemetry(
    gpus: &mut [GpuInfo],
    util_map: &std::collections::HashMap<String, u32>,
    kmt_map: &std::collections::HashMap<String, kmt::Telemetry>,
    mem_map: &std::collections::HashMap<String, u64>,
) -> (bool, bool) {
    struct Tel {
        util: Option<u32>,
        temp_c: Option<u32>,
        clock_mhz: Option<u32>,
        vram_used_bytes: Option<u64>,
        // True when the WDDM kernel has hardware perf data for this LUID — i.e.
        // it's a physical GPU, not a software adapter like the "Microsoft Basic
        // Render Driver" (WARP), which still shows up in the WMI counters.
        is_gpu: bool,
    }
    let blank = || Tel {
        util: None,
        temp_c: None,
        clock_mhz: None,
        vram_used_bytes: None,
        is_gpu: false,
    };
    let mut by_luid: std::collections::HashMap<String, Tel> = std::collections::HashMap::new();
    for (luid, u) in util_map {
        by_luid
            .entry(luid.to_lowercase())
            .or_insert_with(blank)
            .util = Some((*u).min(100));
    }
    for (luid, t) in kmt_map {
        let e = by_luid.entry(luid.to_lowercase()).or_insert_with(blank);
        e.temp_c = t.temp_c;
        e.clock_mhz = t.clock_mhz;
        // Presence in the kernel perf map is the GPU/software-adapter
        // discriminator — D3DKMT returns no perf data for WARP.
        e.is_gpu = true;
    }
    // VRAM usage attaches by LUID to whatever record already exists. The
    // desktop-driving card's large allocation is genuine, so it rides along
    // correctly; the software adapter is excluded by the retain below.
    for (luid, bytes) in mem_map {
        if let Some(e) = by_luid.get_mut(&luid.to_lowercase()) {
            e.vram_used_bytes = Some(*bytes);
        }
    }

    let mut tel: Vec<(String, Tel)> = by_luid.into_iter().collect();
    if tel.iter().any(|(_, t)| t.is_gpu) {
        tel.retain(|(_, t)| t.is_gpu);
    }
    // The LUID token is fixed-width zero-padded hex, so a lexicographic sort
    // equals numeric adapter order.
    tel.sort_by(|a, b| a.0.cmp(&b.0));

    let mut have_wmi = false;
    let mut have_kmt = false;
    for (gpu, (_, t)) in gpus.iter_mut().zip(tel.iter()) {
        if t.util.is_some() {
            have_wmi = true;
        }
        if t.temp_c.is_some() || t.clock_mhz.is_some() {
            have_kmt = true;
        }
        gpu.util = t.util;
        gpu.temp_c = t.temp_c;
        gpu.clock_mhz = t.clock_mhz;
        // Prefer the WDDM/WMI dedicated-usage figure (all processes, matches
        // Task Manager) over HIP's per-process context size.
        if let Some(bytes) = t.vram_used_bytes {
            have_wmi = true;
            gpu.vram_used_gb = bytes as f64 / 1024.0 / 1024.0 / 1024.0;
        }
    }
    (have_wmi, have_kmt)
}

#[cfg(all(test, windows))]
mod merge_tests {
    use super::*;
    use std::collections::HashMap;

    const GB: u64 = 1024 * 1024 * 1024;

    /// A HIP-detected card before telemetry is layered in: 32 GB total, with
    /// HIP's per-process VRAM baseline (~0.3 GB) that the WMI figure replaces.
    fn hip_gpu() -> GpuInfo {
        GpuInfo {
            name: "AMD Radeon AI PRO R9700".into(),
            vram_total_gb: 32.0,
            vram_used_gb: 0.3,
            util: None,
            temp_c: None,
            power_w: None,
            clock_mhz: None,
        }
    }

    fn tel(temp_c: Option<u32>, clock_mhz: Option<u32>) -> kmt::Telemetry {
        kmt::Telemetry { temp_c, clock_mhz }
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn orders_by_luid_not_by_load() {
        // The higher-LUID card is busier and hotter; ordering must still follow
        // LUID ascending so each card keeps a fixed GPU slot regardless of load.
        let lo = "luid_0x00000000_0x00019d9d"; // idle/cool
        let hi = "luid_0x00000000_0x0001d34e"; // busy/hot
        let mut gpus = vec![hip_gpu(), hip_gpu()];
        let util = HashMap::from([(lo.into(), 0u32), (hi.into(), 95u32)]);
        let kmt = HashMap::from([
            (lo.to_string(), tel(Some(40), Some(150))),
            (hi.to_string(), tel(Some(80), Some(2400))),
        ]);
        let mem = HashMap::from([(lo.into(), 3 * GB), (hi.into(), 20 * GB)]);

        let (have_wmi, have_kmt) = merge_gpu_telemetry(&mut gpus, &util, &kmt, &mem);

        assert!(have_wmi && have_kmt);
        // GPU 0 = lowest LUID, even though it's the idle/cool one.
        assert_eq!(gpus[0].util, Some(0));
        assert_eq!(gpus[0].temp_c, Some(40));
        assert!(approx(gpus[0].vram_used_gb, 3.0));
        // GPU 1 = higher LUID, the busy card.
        assert_eq!(gpus[1].util, Some(95));
        assert_eq!(gpus[1].temp_c, Some(80));
        assert!(approx(gpus[1].vram_used_gb, 20.0));
    }

    #[test]
    fn excludes_software_adapter_even_when_its_luid_sorts_first() {
        // WARP has no kernel perf data and the lowest LUID, but it must never
        // take the real card's slot.
        let warp = "luid_0x00000000_0x00000abc";
        let card = "luid_0x00000000_0x0001d34e";
        let mut gpus = vec![hip_gpu()];
        let util = HashMap::from([(warp.into(), 0u32), (card.into(), 50u32)]);
        let kmt = HashMap::from([(card.to_string(), tel(Some(55), Some(2000)))]);
        let mem = HashMap::from([(warp.into(), 0u64), (card.into(), 8 * GB)]);

        merge_gpu_telemetry(&mut gpus, &util, &kmt, &mem);

        assert_eq!(gpus[0].util, Some(50));
        assert_eq!(gpus[0].temp_c, Some(55));
        assert!(approx(gpus[0].vram_used_gb, 8.0));
    }

    #[test]
    fn vram_usage_overrides_hip_per_process_baseline() {
        let card = "luid_0x00000000_0x00000001";
        let mut gpus = vec![hip_gpu()];
        let util = HashMap::new();
        let kmt = HashMap::from([(card.to_string(), tel(None, None))]);
        let mem = HashMap::from([(card.into(), 12 * GB)]);

        let (have_wmi, _) = merge_gpu_telemetry(&mut gpus, &util, &kmt, &mem);

        assert!(have_wmi, "VRAM usage from WMI should set have_wmi");
        assert!(approx(gpus[0].vram_used_gb, 12.0));
    }

    #[test]
    fn keeps_all_records_when_no_kernel_perf_data() {
        // WMI-only machine: with no kmt entries we can't distinguish GPUs from
        // software adapters, so keep every record rather than dropping them all.
        let card = "luid_0x00000000_0x00000001";
        let mut gpus = vec![hip_gpu()];
        let util = HashMap::from([(card.into(), 30u32)]);
        let kmt: HashMap<String, kmt::Telemetry> = HashMap::new();
        let mem = HashMap::new();

        let (have_wmi, have_kmt) = merge_gpu_telemetry(&mut gpus, &util, &kmt, &mem);

        assert!(have_wmi);
        assert!(!have_kmt);
        assert_eq!(gpus[0].util, Some(30));
    }

    #[test]
    fn joins_luid_case_insensitively() {
        // WMI returns uppercase hex LUIDs; the kernel map is lowercase. They
        // must join to the same physical card.
        let mut gpus = vec![hip_gpu()];
        let util = HashMap::from([("luid_0x00000000_0x0001D34E".to_string(), 42u32)]);
        let kmt = HashMap::from([(
            "luid_0x00000000_0x0001d34e".to_string(),
            tel(Some(60), None),
        )]);
        let mem = HashMap::from([("luid_0x00000000_0x0001D34E".to_string(), 5 * GB)]);

        merge_gpu_telemetry(&mut gpus, &util, &kmt, &mem);

        assert_eq!(gpus[0].util, Some(42));
        assert_eq!(gpus[0].temp_c, Some(60));
        assert!(approx(gpus[0].vram_used_gb, 5.0));
    }

    #[test]
    fn clamps_utilization_to_100() {
        let card = "luid_0x00000000_0x00000001";
        let mut gpus = vec![hip_gpu()];
        let util = HashMap::from([(card.into(), 250u32)]);
        let kmt = HashMap::from([(card.to_string(), tel(None, None))]);
        let mem = HashMap::new();

        merge_gpu_telemetry(&mut gpus, &util, &kmt, &mem);

        assert_eq!(gpus[0].util, Some(100));
    }
}
