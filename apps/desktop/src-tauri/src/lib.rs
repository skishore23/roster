use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsStr,
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const SIDECAR_NAME: &str = "roster-runtime";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const VERSION_TIMEOUT: Duration = Duration::from_millis(2_500);
const MAX_STARTUP_DIAGNOSTIC_BYTES: usize = 8 * 1024;
const MAX_RUNTIME_PROFILES_JSON_BYTES: usize = 64 * 1024;
const MAX_SAVED_ONBOARDING_BYTES: u64 = 128 * 1024;
const DESKTOP_ONBOARDING_SCHEMA_VERSION: &str = "roster.desktop-onboarding.v1";
const LOCAL_SPACETIME_URI: &str = "http://127.0.0.1:3000";
const LOCAL_SPACETIME_DATABASE: &str = "roster-local";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSession {
    repository_path: String,
    coding_url: String,
    pid: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredRuntime {
    id: &'static str,
    label: &'static str,
    detail: &'static str,
    runtime_kind: &'static str,
    executable_path: Option<String>,
    version: Option<String>,
    readiness: &'static str,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeProfile {
    id: String,
    label: String,
    runtime_kind: String,
    command: Vec<String>,
    access: String,
    source: String,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedRepository {
    path: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedOnboardingDocument {
    schema_version: String,
    selected_repository: Option<SavedRepository>,
    runtime_profiles: Vec<RuntimeProfile>,
    #[serde(default)]
    default_runtime_id: Option<String>,
    stage: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedDesktopSetup {
    repository_path: String,
    runtime_ids: Vec<String>,
    default_runtime_id: String,
}

#[derive(Debug)]
struct RuntimeProcess {
    child: CommandChild,
    session: RuntimeSession,
    port: u16,
    configuration: RuntimeConfiguration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RuntimeConfiguration {
    repository_path: String,
    runtime_profiles_json: String,
    default_runtime_id: String,
    spacetime_mode: String,
    spacetime_uri: String,
    spacetime_database: String,
}

#[derive(Default)]
struct RuntimeState(Mutex<Option<RuntimeProcess>>);

impl Drop for RuntimeState {
    fn drop(&mut self) {
        let process = self.0.get_mut().ok().and_then(Option::take);
        if let Some(process) = process {
            terminate_process(process);
        }
    }
}

#[derive(Default)]
struct StartupObservation {
    terminated: bool,
    diagnostic: String,
}

struct RuntimeDescriptor {
    id: &'static str,
    label: &'static str,
    detail: &'static str,
    runtime_kind: &'static str,
    executable: &'static str,
}

const RUNTIME_DESCRIPTORS: &[RuntimeDescriptor] = &[
    RuntimeDescriptor {
        id: "codex-cli",
        label: "Codex",
        detail: "OpenAI Codex CLI",
        runtime_kind: "codex-cli",
        executable: "codex",
    },
    RuntimeDescriptor {
        id: "claude-code",
        label: "Claude Code",
        detail: "Anthropic Claude Code",
        runtime_kind: "claude-code",
        executable: "claude",
    },
    RuntimeDescriptor {
        id: "pi-agent",
        label: "Pi",
        detail: "Pi coding agent",
        runtime_kind: "pi-agent",
        executable: "pi",
    },
    RuntimeDescriptor {
        id: "hermes-agent",
        label: "Hermes",
        detail: "Nous Hermes Agent",
        runtime_kind: "hermes-agent",
        executable: "hermes",
    },
];

fn command_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn spacetime_config() -> Result<(String, String, String), String> {
    spacetime_config_from(|name| env::var(name).ok())
}

fn spacetime_config_from(get: impl Fn(&str) -> Option<String>) -> Result<(String, String, String), String> {
    let mode = get("ROSTER_SPACETIME_MODE").unwrap_or_else(|| "local".to_string());
    match mode.as_str() {
        "local" => Ok((
            mode.clone(),
            get("ROSTER_SPACETIME_LOCAL_URI")
                .unwrap_or_else(|| LOCAL_SPACETIME_URI.to_string()),
            get("ROSTER_SPACETIME_LOCAL_DATABASE")
                .unwrap_or_else(|| LOCAL_SPACETIME_DATABASE.to_string()),
        )),
        "production" => Ok((
            mode.clone(),
            get("ROSTER_SPACETIME_PRODUCTION_URI")
                .filter(|value| !value.trim().is_empty())
                .ok_or("Set ROSTER_SPACETIME_PRODUCTION_URI to your own deployment")?,
            get("ROSTER_SPACETIME_PRODUCTION_DATABASE")
                .filter(|value| !value.trim().is_empty())
                .ok_or("Set ROSTER_SPACETIME_PRODUCTION_DATABASE to your own deployment")?,
        )),
        _ => Err("ROSTER_SPACETIME_MODE must be local or production".into()),
    }
}

fn canonical_repository(path: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| command_error("Could not open the selected folder", error))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| command_error("Could not inspect the selected folder", error))?;
    if !metadata.is_dir() {
        return Err("The selected workspace must be a folder".into());
    }
    let root = canonical
        .ancestors()
        .last()
        .ok_or_else(|| "Could not inspect the selected folder root".to_string())?;
    if canonical == root {
        return Err("Select a repository folder, not the filesystem root".into());
    }
    let git_root = Command::new("git")
        .args([
            "-C",
            canonical.to_string_lossy().as_ref(),
            "rev-parse",
            "--show-toplevel",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| command_error("Could not inspect this Git repository", error))?;
    if !git_root.status.success() {
        return Err("Select a folder inside a Git repository".into());
    }
    let reported_root = String::from_utf8_lossy(&git_root.stdout);
    let reported_root = reported_root.trim();
    let canonical_git_root = fs::canonicalize(reported_root)
        .map_err(|error| command_error("Could not resolve this Git repository", error))?;
    if canonical != canonical_git_root {
        return Err(format!(
            "Select the repository root: {}",
            canonical_git_root.display()
        ));
    }
    Ok(canonical)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn executable_candidates(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let extensions = env::var_os("PATHEXT")
            .map(|value| {
                value
                    .to_string_lossy()
                    .split(';')
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![".EXE".into(), ".CMD".into(), ".BAT".into()]);
        return extensions
            .into_iter()
            .map(|extension| format!("{name}{extension}"))
            .collect();
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

fn find_executable_with_path(
    name: &str,
    preferred_directories: &[PathBuf],
    fallback_directories: &[PathBuf],
    path: Option<&OsStr>,
) -> Option<PathBuf> {
    let path_directories = path
        .map(|value| env::split_paths(value).collect::<Vec<_>>())
        .unwrap_or_default();
    for directory in preferred_directories
        .iter()
        .cloned()
        .chain(path_directories)
        .chain(fallback_directories.iter().cloned())
    {
        for candidate in executable_candidates(name) {
            let executable = directory.join(candidate);
            if is_executable(&executable) {
                if let Ok(canonical) = fs::canonicalize(executable) {
                    return Some(canonical);
                }
            }
        }
    }
    None
}

fn find_executable(
    name: &str,
    preferred_directories: &[PathBuf],
    fallback_directories: &[PathBuf],
) -> Option<PathBuf> {
    find_executable_with_path(
        name,
        preferred_directories,
        fallback_directories,
        env::var_os("PATH").as_deref(),
    )
}

fn configured_runtime_directories() -> Vec<PathBuf> {
    env::var_os("ROSTER_CODING_CLI_PATH")
        .map(|value| {
            env::split_paths(&value)
                .filter(|directory| directory.is_absolute())
                .collect()
        })
        .unwrap_or_default()
}

fn macos_runtime_directories(home: Option<&Path>) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(home) = home {
        directories.extend([
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".bun/bin"),
            home.join(".volta/bin"),
            home.join(".npm-global/bin"),
            home.join(".local/share/pnpm"),
            home.join("Applications/ChatGPT.app/Contents/Resources"),
            home.join("Applications/Codex.app/Contents/Resources"),
        ]);
    }
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources"),
    ]);
    directories
}

fn desktop_runtime_directories(app: &AppHandle) -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = app.path().home_dir().ok();
        macos_runtime_directories(home.as_deref())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Vec::new()
    }
}

fn runtime_resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| command_error("Could not resolve Roster runtime resources", error))?;
    let packaged = resource_dir.join("runtime");
    if packaged.is_dir() {
        return Ok(packaged);
    }

    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime");
        if development.is_dir() {
            return Ok(development);
        }
    }

    Err(format!(
        "The packaged Roster runtime resources are missing at {}",
        packaged.display()
    ))
}

fn bundled_runtime_directories(app: &AppHandle) -> Vec<PathBuf> {
    runtime_resource_root(app)
        .map(|root| vec![root.join("bin")])
        .unwrap_or_default()
}

fn read_bounded(pipe: Option<impl Read>, max_bytes: u64) -> String {
    let mut output = String::new();
    if let Some(pipe) = pipe {
        let _ = pipe.take(max_bytes).read_to_string(&mut output);
    }
    output
}

fn probe_version(executable: &Path) -> Result<String, ()> {
    let mut child = Command::new(executable)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ())?;
    let deadline = Instant::now() + VERSION_TIMEOUT;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = read_bounded(child.stdout.take(), 8 * 1024);
                let stderr = read_bounded(child.stderr.take(), 8 * 1024);
                if !status.success() {
                    return Err(());
                }
                let version = format!("{stdout}\n{stderr}")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                if version.is_empty() {
                    return Err(());
                }
                return Ok(version.chars().take(160).collect());
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(());
            }
        }
    }
}

#[tauri::command]
fn discover_coding_runtimes(app: AppHandle) -> Vec<DiscoveredRuntime> {
    let bundled_directories = bundled_runtime_directories(&app);
    let configured_directories = configured_runtime_directories();
    let fallback_directories = desktop_runtime_directories(&app);
    RUNTIME_DESCRIPTORS
        .iter()
        .map(|descriptor| {
            let mut preferred_directories = configured_directories.clone();
            if descriptor.id == "pi-agent" {
                preferred_directories.splice(0..0, bundled_directories.iter().cloned());
            }
            match find_executable(
                descriptor.executable,
                &preferred_directories,
                &fallback_directories,
            ) {
                Some(path) => {
                    let version = probe_version(&path).ok();
                    DiscoveredRuntime {
                        id: descriptor.id,
                        label: descriptor.label,
                        detail: descriptor.detail,
                        runtime_kind: descriptor.runtime_kind,
                        executable_path: Some(path.to_string_lossy().into_owned()),
                        readiness: if version.is_some() {
                            "ready"
                        } else {
                            "probe-failed"
                        },
                        version,
                    }
                }
                None => DiscoveredRuntime {
                    id: descriptor.id,
                    label: descriptor.label,
                    detail: descriptor.detail,
                    runtime_kind: descriptor.runtime_kind,
                    executable_path: None,
                    version: None,
                    readiness: "not-installed",
                },
            }
        })
        .collect()
}

fn validate_runtime_profiles_json(
    app: &AppHandle,
    value: &str,
) -> Result<Vec<RuntimeProfile>, String> {
    if value.len() > MAX_RUNTIME_PROFILES_JSON_BYTES || value.contains('\0') {
        return Err("Runtime configuration is too large or contains invalid bytes".into());
    }
    let profiles: Vec<RuntimeProfile> = serde_json::from_str(value)
        .map_err(|error| command_error("Runtime configuration is invalid JSON", error))?;
    if profiles.is_empty() {
        return Err("Enable at least one installed coding agent to continue".into());
    }
    if profiles.len() > 32 {
        return Err("Roster supports at most 32 configured coding agents".into());
    }
    let bundled_directories = bundled_runtime_directories(app);
    let configured_directories = configured_runtime_directories();
    let fallback_directories = desktop_runtime_directories(app);
    for profile in &profiles {
        let descriptor = RUNTIME_DESCRIPTORS
            .iter()
            .find(|descriptor| descriptor.id == profile.id)
            .ok_or_else(|| format!("Unsupported coding runtime {}", profile.id))?;
        if !profile.enabled {
            return Err(format!(
                "Disabled runtime {} must not be sent to the launcher",
                profile.id
            ));
        }
        if profile.label.trim().is_empty() || profile.label.len() > 120 {
            return Err(format!("Runtime {} has an invalid label", profile.id));
        }
        if profile.runtime_kind != descriptor.runtime_kind {
            return Err(format!(
                "Runtime {} has an invalid adapter kind",
                profile.id
            ));
        }
        if profile.source != "discovered" {
            return Err(format!(
                "Runtime {} must be selected from local discovery",
                profile.id
            ));
        }
        if profile.access != "read-only" && profile.access != "workspace-write" {
            return Err(format!(
                "Runtime {} has an invalid access policy",
                profile.id
            ));
        }
        if profile.command.len() != 1 {
            return Err(format!("Runtime {} has an invalid command", profile.id));
        }
        let command = PathBuf::from(&profile.command[0]);
        if !command.is_absolute() || !is_executable(&command) {
            return Err(format!("Runtime {} executable is unavailable", profile.id));
        }
        let mut preferred_directories = configured_directories.clone();
        if descriptor.id == "pi-agent" {
            preferred_directories.splice(0..0, bundled_directories.iter().cloned());
        }
        let discovered = find_executable(
            descriptor.executable,
            &preferred_directories,
            &fallback_directories,
        )
        .ok_or_else(|| format!("Runtime {} is no longer installed", profile.id))?;
        let submitted = fs::canonicalize(command)
            .map_err(|error| command_error("Could not resolve selected coding runtime", error))?;
        if submitted != discovered {
            return Err(format!(
                "Runtime {} changed after discovery; scan installed agents again",
                profile.id
            ));
        }
    }
    Ok(profiles)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| command_error("Could not resolve Roster application data", error))
}

#[tauri::command]
fn load_saved_desktop_setup(app: AppHandle) -> Result<Option<SavedDesktopSetup>, String> {
    let onboarding_path = app_data_dir(&app)?.join("onboarding.json");
    let metadata = match fs::metadata(&onboarding_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(command_error(
                "Could not inspect the saved Roster setup",
                error,
            ))
        }
    };
    if !metadata.is_file() || metadata.len() > MAX_SAVED_ONBOARDING_BYTES {
        return Err("The saved Roster setup is not a bounded regular file".into());
    }
    let source = fs::read_to_string(&onboarding_path)
        .map_err(|error| command_error("Could not read the saved Roster setup", error))?;
    let document: SavedOnboardingDocument = serde_json::from_str(&source)
        .map_err(|error| command_error("The saved Roster setup is invalid", error))?;
    if document.schema_version != DESKTOP_ONBOARDING_SCHEMA_VERSION {
        return Err("The saved Roster setup uses an unsupported schema".into());
    }
    if document.stage != "ready" {
        return Ok(None);
    }
    let saved_repository = document
        .selected_repository
        .ok_or_else(|| "The saved Roster setup has no repository".to_string())?;
    if saved_repository.name.trim().is_empty() || saved_repository.name.len() > 120 {
        return Err("The saved Roster repository name is invalid".into());
    }
    let repository = canonical_repository(&saved_repository.path)?;
    if document.runtime_profiles.is_empty() || document.runtime_profiles.len() > 32 {
        return Err("The saved Roster setup has an invalid agent selection".into());
    }

    let mut runtime_ids = Vec::new();
    for profile in document.runtime_profiles {
        if !profile.enabled {
            continue;
        }
        let descriptor = RUNTIME_DESCRIPTORS
            .iter()
            .find(|descriptor| descriptor.id == profile.id)
            .ok_or_else(|| format!("Saved coding runtime {} is no longer supported", profile.id))?;
        if profile.source != "discovered"
            || profile.runtime_kind != descriptor.runtime_kind
            || profile.command.len() != 1
            || (profile.access != "read-only" && profile.access != "workspace-write")
        {
            return Err(format!("Saved coding runtime {} is invalid", profile.id));
        }
        if runtime_ids.iter().any(|id| id == &profile.id) {
            return Err(format!("Saved coding runtime {} is duplicated", profile.id));
        }
        runtime_ids.push(profile.id);
    }
    let default_runtime_id = match document.default_runtime_id {
        Some(default_runtime_id) if runtime_ids.iter().any(|id| id == &default_runtime_id) => {
            default_runtime_id
        }
        Some(_) => return Err("The saved Roster default coding runtime is not enabled".to_string()),
        None => runtime_ids
            .first()
            .cloned()
            .ok_or_else(|| "The saved Roster setup has no enabled coding runtime".to_string())?,
    };

    Ok(Some(SavedDesktopSetup {
        repository_path: repository.to_string_lossy().into_owned(),
        runtime_ids,
        // The renderer persists the default profile first. Runtime discovery
        // resolves its current executable without trusting the saved command.
        default_runtime_id,
    }))
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| command_error("Could not reserve a local Roster port", error))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| command_error("Could not inspect the local Roster port", error))
}

fn record_startup_diagnostic(observation: &Arc<Mutex<StartupObservation>>, bytes: &[u8]) {
    let Ok(mut observation) = observation.lock() else {
        return;
    };
    observation
        .diagnostic
        .push_str(&String::from_utf8_lossy(bytes));
    if observation.diagnostic.len() > MAX_STARTUP_DIAGNOSTIC_BYTES {
        let mut start = observation.diagnostic.len() - MAX_STARTUP_DIAGNOSTIC_BYTES;
        while !observation.diagnostic.is_char_boundary(start) {
            start += 1;
        }
        observation.diagnostic.drain(..start);
    }
}

fn startup_termination_error(observation: &StartupObservation) -> String {
    let diagnostic = observation.diagnostic.trim();
    if diagnostic.is_empty() {
        "Roster's local runtime exited before opening the room".to_string()
    } else {
        format!(
            "Roster's local runtime could not start:\n{}",
            startup_diagnostic_summary(diagnostic)
        )
    }
}

fn startup_diagnostic_summary(diagnostic: &str) -> String {
    let candidate = diagnostic
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("Error: "))
        .or_else(|| {
            diagnostic.lines().map(str::trim).find(|line| {
                !line.is_empty()
                    && !line.starts_with("file://")
                    && !line.starts_with("at ")
                    && !line.starts_with("return ")
                    && *line != "^"
            })
        })
        .unwrap_or("The local runtime exited before it became ready");
    let actionable = candidate
        .split(" Cause:")
        .next()
        .unwrap_or(candidate)
        .trim();
    actionable.chars().take(600).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReadyResponse {
    ok: bool,
    state: String,
    control_plane: String,
}

fn runtime_is_ready(port: u16) -> bool {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let Ok(mut stream) = TcpStream::connect_timeout(&address.into(), Duration::from_millis(250))
    else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    let request =
        format!("GET /readyz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::new();
    if stream.take(16 * 1024).read_to_end(&mut response).is_err() {
        return false;
    }
    runtime_ready_response_is_valid(&response)
}

fn runtime_ready_response_is_valid(response: &[u8]) -> bool {
    let Ok(response) = std::str::from_utf8(&response) else {
        return false;
    };
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !headers
        .lines()
        .next()
        .is_some_and(|line| line == "HTTP/1.1 200 OK" || line == "HTTP/1.0 200 OK")
    {
        return false;
    }
    serde_json::from_str::<RuntimeReadyResponse>(body)
        .is_ok_and(|ready| ready.ok && ready.state == "ready" && ready.control_plane == "connected")
}

fn wait_for_runtime_ready(
    port: u16,
    observation: &Arc<Mutex<StartupObservation>>,
) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if runtime_is_ready(port) {
            return Ok(());
        }
        if let Ok(observation) = observation.lock() {
            if observation.terminated {
                return Err(startup_termination_error(&observation));
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "Roster's local runtime did not become ready within {} seconds",
        STARTUP_TIMEOUT.as_secs()
    ))
}

fn runtime_entry(app: &AppHandle) -> Result<PathBuf, String> {
    let packaged = runtime_resource_root(app)?
        .join("dist")
        .join("desktop")
        .join("runtime.js");
    if packaged.is_file() {
        return Ok(packaged);
    }

    Err(format!(
        "The packaged Roster desktop runtime is missing at {}",
        packaged.display()
    ))
}

fn terminate_process(mut process: RuntimeProcess) {
    let _ = process
        .child
        .write(b"{\"schemaVersion\":\"roster.desktop-control.v1\",\"type\":\"shutdown\"}\n");

    #[cfg(unix)]
    unsafe {
        libc::kill(process.child.pid() as i32, libc::SIGTERM);
    }

    thread::sleep(Duration::from_millis(750));
    let _ = process.child.kill();
}

fn stop_current_runtime(state: &RuntimeState) {
    let process = state.0.lock().ok().and_then(|mut current| current.take());
    if let Some(process) = process {
        terminate_process(process);
    }
}

#[tauri::command]
fn stop_roster_runtime(state: State<'_, RuntimeState>) {
    stop_current_runtime(&state);
}

#[tauri::command]
async fn start_roster_runtime(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    workspace_path: String,
    runtime_profiles_json: String,
    default_runtime_id: String,
) -> Result<RuntimeSession, String> {
    let runtime_profiles = validate_runtime_profiles_json(&app, &runtime_profiles_json)?;
    let default_runtime = runtime_profiles
        .iter()
        .find(|profile| profile.id == default_runtime_id)
        .ok_or_else(|| {
            "Choose one enabled installed agent as the default coding runtime".to_string()
        })?;
    let default_runtime_kind = default_runtime.runtime_kind.clone();
    let (spacetime_mode, spacetime_uri, spacetime_database) = spacetime_config()?;
    let repository = canonical_repository(&workspace_path)?;
    let repository_string = repository.to_string_lossy().into_owned();
    let normalized_runtime_profiles_json = serde_json::to_string(&runtime_profiles)
        .map_err(|error| command_error("Could not normalize selected coding runtimes", error))?;
    let configuration = RuntimeConfiguration {
        repository_path: repository_string.clone(),
        runtime_profiles_json: normalized_runtime_profiles_json.clone(),
        default_runtime_id: default_runtime_id.clone(),
        spacetime_mode: spacetime_mode.clone(),
        spacetime_uri: spacetime_uri.clone(),
        spacetime_database: spacetime_database.clone(),
    };

    let reusable_session = {
        let current = state
            .0
            .lock()
            .map_err(|_| "Roster runtime state is unavailable".to_string())?;
        current.as_ref().and_then(|process| {
            (process.configuration == configuration && runtime_is_ready(process.port))
                .then(|| process.session.clone())
        })
    };
    if let Some(session) = reusable_session {
        return Ok(session);
    }
    stop_current_runtime(&state);

    let port = reserve_loopback_port()?;
    let mut secret_bytes = [0u8; 32];
    getrandom::fill(&mut secret_bytes)
        .map_err(|_| "Could not create local workspace access token".to_string())?;
    let http_token: String = secret_bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let runtime_entry = runtime_entry(&app)?;
    let data_directory = app_data_dir(&app)?;
    fs::create_dir_all(&data_directory)
        .map_err(|error| command_error("Could not create Roster application data", error))?;
    let repository_name = repository
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Local workspace");
    let (mut receiver, child) = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| command_error("Could not locate the bundled Node runtime", error))?
        .arg(&runtime_entry)
        .current_dir(&repository)
        .envs([
            (
                "ROSTER_DESKTOP_DATA_DIR",
                data_directory.to_string_lossy().into_owned(),
            ),
            (
                "ROSTER_DESKTOP_REPOSITORY",
                repository.to_string_lossy().into_owned(),
            ),
            (
                "ROSTER_DESKTOP_REPOSITORY_NAME",
                repository_name.to_string(),
            ),
            (
                "ROSTER_DESKTOP_RUNTIME_PROFILES",
                normalized_runtime_profiles_json,
            ),
            ("ROSTER_DESKTOP_DEFAULT_RUNTIME_ID", default_runtime_id),
            ("ROSTER_DESKTOP_PARENT_PID", std::process::id().to_string()),
            ("ROSTER_DESKTOP_PORT", port.to_string()),
            ("ROSTER_DESKTOP_HTTP_TOKEN", http_token.clone()),
            ("ROSTER_CODING_LOCAL_ONLY", "1".to_string()),
            ("ROSTER_SERVER_SURFACE", "repository".to_string()),
            ("ROSTER_CODING_DEFAULT_RUNTIME", default_runtime_kind),
            ("ROSTER_SPACETIME_MODE", spacetime_mode.clone()),
            ("ROSTER_SPACETIME_URI", spacetime_uri),
            ("ROSTER_SPACETIME_DATABASE", spacetime_database),
        ])
        .spawn()
        .map_err(|error| command_error("Could not start the bundled Roster runtime", error))?;

    let pid = child.pid();
    let startup_observation = Arc::new(Mutex::new(StartupObservation::default()));
    let session = RuntimeSession {
        repository_path: repository_string,
        coding_url: format!("http://127.0.0.1:{port}/auth#token={http_token}"),
        pid,
    };
    {
        let mut current = state
            .0
            .lock()
            .map_err(|_| "Roster runtime state is unavailable".to_string())?;
        *current = Some(RuntimeProcess {
            child,
            session: session.clone(),
            port,
            configuration,
        });
    }

    let monitor_app = app.clone();
    let monitor_startup_observation = Arc::clone(&startup_observation);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    record_startup_diagnostic(&monitor_startup_observation, &bytes);
                }
                CommandEvent::Error(error) => {
                    record_startup_diagnostic(&monitor_startup_observation, error.as_bytes());
                }
                CommandEvent::Terminated(_) => {
                    if let Ok(mut observation) = monitor_startup_observation.lock() {
                        observation.terminated = true;
                    }
                    let state = monitor_app.state::<RuntimeState>();
                    if let Ok(mut current) = state.0.lock() {
                        if current
                            .as_ref()
                            .is_some_and(|process| process.session.pid == pid)
                        {
                            current.take();
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    match tauri::async_runtime::spawn_blocking(move || {
        wait_for_runtime_ready(port, &startup_observation)
    })
    .await
    {
        Ok(Ok(())) => Ok(session),
        Ok(Err(error)) => {
            stop_current_runtime(&state);
            Err(error)
        }
        Err(error) => {
            stop_current_runtime(&state);
            Err(command_error("Roster startup check failed", error))
        }
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            discover_coding_runtimes,
            load_saved_desktop_setup,
            start_roster_runtime,
            stop_roster_runtime
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Roster desktop");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            let state = app_handle.state::<RuntimeState>();
            stop_current_runtime(&state);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{
        find_executable_with_path, macos_runtime_directories, runtime_ready_response_is_valid,
        startup_diagnostic_summary, RuntimeConfiguration,
        spacetime_config_from, LOCAL_SPACETIME_URI, LOCAL_SPACETIME_DATABASE,
    };
    use std::{env, fs, path::Path, time::SystemTime};

    const READY_BODY: &str = r#"{"ok":true,"state":"ready","controlPlane":"connected"}"#;

    #[test]
    fn readiness_requires_the_exact_roster_control_plane_contract() {
        let ready =
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{READY_BODY}");
        assert!(runtime_ready_response_is_valid(ready.as_bytes()));

        for response in [
            "HTTP/1.1 503 Service Unavailable\r\n\r\n{\"ok\":true,\"state\":\"ready\",\"controlPlane\":\"connected\"}",
            "HTTP/1.1 200 OK\r\n\r\n{\"ok\":false,\"state\":\"ready\",\"controlPlane\":\"connected\"}",
            "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"state\":\"ready\",\"controlPlane\":\"disconnected\"}",
            "HTTP/1.1 200 OK\r\n\r\nnot-json",
        ] {
            assert!(!runtime_ready_response_is_valid(response.as_bytes()));
        }
    }

    #[test]
    fn startup_diagnostics_surface_the_actionable_error_without_a_stack_dump() {
        let diagnostic = r#"file:///tmp/runtime/dist/adapters/spacetimedb-control.js:30
    return new Error(`SpacetimeDB startup validation failed`)
           ^

Error: SpacetimeDB startup validation failed for database 'roster-local' at http://127.0.0.1:3000. Confirm the current Roster module is published before restarting. Cause: [object ErrorEvent].
    at spacetimeStartupFailure (file:///tmp/runtime/dist/adapters/spacetimedb-control.js:30:12)
    at async file:///tmp/runtime/dist/server.js:148:31"#;

        let summary = startup_diagnostic_summary(diagnostic);
        assert!(summary.contains("database 'roster-local'"));
        assert!(summary.contains("Confirm the current Roster module is published"));
        assert!(!summary.contains("file:///"));
        assert!(!summary.contains("[object ErrorEvent]"));
        assert!(!summary.contains("    at "));
    }

    #[test]
    fn runtime_reuse_identity_includes_agent_and_backend_selection() {
        let baseline = RuntimeConfiguration {
            repository_path: "/workspace/repository".into(),
            runtime_profiles_json: "[{\"id\":\"pi-agent\"}]".into(),
            default_runtime_id: "pi-agent".into(),
            spacetime_mode: "production".into(),
            spacetime_uri: "https://maincloud.spacetimedb.com".into(),
            spacetime_database: "roster-example".into(),
        };
        assert_eq!(baseline, baseline.clone());
        assert_ne!(
            baseline,
            RuntimeConfiguration {
                default_runtime_id: "codex-cli".into(),
                ..baseline.clone()
            }
        );
        assert_ne!(
            baseline,
            RuntimeConfiguration {
                spacetime_database: "roster-next".into(),
                ..baseline.clone()
            }
        );
    }

    #[test]
    fn backend_defaults_to_local_and_remote_requires_an_explicit_target() {
        assert_eq!(spacetime_config_from(|_| None).unwrap(), (
            "local".to_string(), LOCAL_SPACETIME_URI.to_string(), LOCAL_SPACETIME_DATABASE.to_string(),
        ));
        assert!(spacetime_config_from(|name| (name == "ROSTER_SPACETIME_MODE").then(|| "production".to_string())).is_err());
        let remote = |name: &str| match name {
            "ROSTER_SPACETIME_MODE" => Some("production".to_string()),
            "ROSTER_SPACETIME_PRODUCTION_URI" => Some("https://database.example".to_string()),
            "ROSTER_SPACETIME_PRODUCTION_DATABASE" => Some("my-roster".to_string()),
            _ => None,
        };
        assert_eq!(spacetime_config_from(remote).unwrap().2, "my-roster");
        assert!(spacetime_config_from(|name| if name == "ROSTER_SPACETIME_PRODUCTION_DATABASE" { Some(" ".to_string()) } else { remote(name) }).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn minimal_gui_path_falls_back_to_bounded_macos_runtime_locations() {
        use std::os::unix::fs::PermissionsExt;

        let suffix = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "roster-desktop-runtime-discovery-{}-{suffix}",
            std::process::id()
        ));
        let home = root.join("home");
        let local_bin = home.join(".local/bin");
        let chatgpt_resources = home.join("Applications/ChatGPT.app/Contents/Resources");
        let bundled_bin = root.join("runtime/bin");
        for directory in [&local_bin, &chatgpt_resources, &bundled_bin] {
            fs::create_dir_all(directory).expect("runtime fixture directory should be created");
        }
        for executable in [
            local_bin.join("claude"),
            local_bin.join("hermes"),
            chatgpt_resources.join("codex"),
            bundled_bin.join("pi"),
        ] {
            fs::write(&executable, "#!/bin/sh\nexit 0\n")
                .expect("runtime fixture should be written");
            let mut permissions = fs::metadata(&executable)
                .expect("runtime fixture metadata should be readable")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&executable, permissions)
                .expect("runtime fixture should be executable");
        }

        let fallback = macos_runtime_directories(Some(&home));
        let minimal_path = env::join_paths([Path::new("/usr/bin"), Path::new("/bin")])
            .expect("minimal GUI PATH should be valid");
        for (name, expected) in [
            ("codex", chatgpt_resources.join("codex")),
            ("claude", local_bin.join("claude")),
            ("hermes", local_bin.join("hermes")),
        ] {
            assert_eq!(
                find_executable_with_path(name, &[], &fallback, Some(&minimal_path)),
                Some(fs::canonicalize(expected).expect("fixture should canonicalize")),
            );
        }
        assert_eq!(
            find_executable_with_path(
                "pi",
                std::slice::from_ref(&bundled_bin),
                &fallback,
                Some(&minimal_path),
            ),
            Some(
                fs::canonicalize(bundled_bin.join("pi"))
                    .expect("bundled Pi fixture should canonicalize")
            ),
        );

        fs::remove_dir_all(root).expect("runtime fixture should be removed");
    }
}
