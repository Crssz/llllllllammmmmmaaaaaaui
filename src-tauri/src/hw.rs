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
    use wmi::{COMLibrary, WMIConnection};

    #[derive(Deserialize, Debug)]
    #[serde(rename_all = "PascalCase")]
    struct GpuEngine {
        name: String,
        utilization_percentage: u64,
    }

    /// Returns a map of LUID-token → highest engine utilization (%) seen for
    /// that physical adapter. Empty on any failure (WMI unavailable, query
    /// rejected, etc.).
    pub fn query_util_by_luid() -> HashMap<String, u32> {
        let com = match COMLibrary::new() {
            Ok(c) => c,
            Err(e) => {
                log::debug!("wmi: COM init failed: {e}");
                return HashMap::new();
            }
        };
        let wmi = match WMIConnection::new(com) {
            Ok(w) => w,
            Err(e) => {
                log::debug!("wmi: connection failed: {e}");
                return HashMap::new();
            }
        };
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
            let s =
                "pid_1234_luid_0x00000000_0x0000ABCD_phys_0_eng_3_engtype_3D";
            assert_eq!(extract_luid(s).as_deref(), Some("luid_0x00000000_0x0000ABCD"));
        }

        #[test]
        fn extract_luid_none_for_unrelated_string() {
            assert!(extract_luid("nothing here").is_none());
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
                // Layer in WMI engine utilization. We can't reliably map LUID
                // → HIP device index, so we sort the per-adapter maxima
                // descending and assign them to detected GPUs in order. For
                // single-AMD-GPU machines (the common case) this is exact.
                let util_map = gpu_perf::query_util_by_luid();
                let mut have_wmi = false;
                if !util_map.is_empty() {
                    let mut utils: Vec<u32> = util_map.into_values().collect();
                    utils.sort_unstable_by(|a, b| b.cmp(a));
                    for (idx, gpu) in out.iter_mut().enumerate() {
                        if let Some(u) = utils.get(idx) {
                            gpu.util = Some((*u).min(100));
                            have_wmi = true;
                        }
                    }
                }
                let label: &'static str = if have_wmi { "HIP + WMI" } else { "HIP" };
                return (out, label);
            }
        }
    }

    (vec![], "unavailable")
}
