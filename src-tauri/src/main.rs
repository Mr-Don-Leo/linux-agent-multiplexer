#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod projects;
mod session;

use config::{AppConfig, Provider};
use projects::{memory_file_name, NewProject, Project};
use serde::Serialize;
use session::{SessionInfo, SessionManager};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

type Sessions<'a> = State<'a, Arc<SessionManager>>;

#[tauri::command]
fn get_config() -> AppConfig {
    config::load_config()
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    config::store_config(&config)
}

#[tauri::command]
fn list_projects() -> Vec<Project> {
    projects::load_projects()
}

#[tauri::command]
fn create_project(project: NewProject) -> Result<Project, String> {
    projects::create_project(project)
}

#[tauri::command]
fn update_project(id: String, project: NewProject) -> Result<Project, String> {
    projects::update_project(&id, project)
}

#[tauri::command]
fn delete_project(id: String) -> Result<(), String> {
    projects::delete_project(&id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliStatus {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
}

#[tauri::command]
fn check_cli(provider: Provider) -> CliStatus {
    let name = match provider {
        Provider::Claude => "claude",
        Provider::Codex => "codex",
    };
    match session::find_cli(name) {
        Some(path) => {
            let version = std::process::Command::new(&path)
                .arg("--version")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .next()
                        .map(|l| l.trim().to_string())
                });
            CliStatus {
                installed: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
            }
        }
        None => CliStatus {
            installed: false,
            version: None,
            path: None,
        },
    }
}

fn find_project(id: &str) -> Result<Project, String> {
    projects::load_projects()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "No such project".to_string())
}

#[tauri::command]
fn session_create(
    app: AppHandle,
    sessions: Sessions<'_>,
    project_id: String,
    resume: Option<bool>,
    kind: Option<String>,
) -> Result<SessionInfo, String> {
    let project = find_project(&project_id)?;
    let resume = resume.unwrap_or(false);
    if kind.as_deref() == Some("chat") {
        sessions.create_chat_for_project(&app, &project, resume)
    } else {
        sessions.create_for_project(&app, &project, resume)
    }
}

/// One chat protocol line: raw stream-json for Claude sessions, or a
/// {"type":"user_text"|"interrupt"} control value for Codex sessions.
#[tauri::command]
fn chat_send(
    app: AppHandle,
    sessions: Sessions<'_>,
    id: String,
    line: String,
) -> Result<(), String> {
    sessions.chat_send(&app, &id, &line)
}

/// Sessions left open by the previous run (one entry per session). Consumed on
/// first call.
#[tauri::command]
fn restorable_sessions() -> Vec<session::OpenSession> {
    session::take_restorable()
}

#[tauri::command]
fn usage_records() -> Vec<session::UsageRecord> {
    session::load_usage()
}

#[tauri::command]
fn session_create_login(
    app: AppHandle,
    sessions: Sessions<'_>,
    provider: Provider,
) -> Result<SessionInfo, String> {
    sessions.create_login(&app, provider)
}

#[tauri::command]
fn session_list(sessions: Sessions<'_>) -> Vec<SessionInfo> {
    sessions.list()
}

#[tauri::command]
fn session_write(sessions: Sessions<'_>, id: String, data: String) -> Result<(), String> {
    sessions.write(&id, &data)
}

#[tauri::command]
fn session_resize(sessions: Sessions<'_>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    sessions.resize(&id, cols, rows)
}

#[tauri::command]
fn session_attach(app: AppHandle, sessions: Sessions<'_>, id: String) -> Result<(), String> {
    sessions.attach(&app, &id)
}

#[tauri::command]
fn session_detach(sessions: Sessions<'_>, id: String) {
    sessions.detach(&id)
}

#[tauri::command]
fn session_kill(sessions: Sessions<'_>, id: String) -> Result<(), String> {
    sessions.kill(&id)
}

fn memory_path(scope: &str, project_id: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "project" => {
            let project = find_project(project_id.ok_or("projectId required")?)?;
            Ok(PathBuf::from(&project.path).join(memory_file_name(project.provider)))
        }
        "global" => {
            let home = dirs::home_dir().ok_or("Could not resolve home directory")?;
            let provider = match project_id {
                Some(id) => find_project(id)?.provider,
                None => Provider::Claude,
            };
            Ok(match provider {
                Provider::Claude => home.join(".claude").join("CLAUDE.md"),
                Provider::Codex => home.join(".codex").join("AGENTS.md"),
            })
        }
        other => Err(format!("Unknown memory scope: {other}")),
    }
}

#[tauri::command]
fn read_memory(scope: String, project_id: Option<String>) -> Result<String, String> {
    let path = memory_path(&scope, project_id.as_deref())?;
    Ok(fs::read_to_string(path).unwrap_or_default())
}

#[tauri::command]
fn write_memory(scope: String, content: String, project_id: Option<String>) -> Result<(), String> {
    let path = memory_path(&scope, project_id.as_deref())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(SessionManager::default()))
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            list_projects,
            create_project,
            update_project,
            delete_project,
            check_cli,
            session_create,
            session_create_login,
            session_list,
            session_write,
            session_resize,
            session_attach,
            session_detach,
            session_kill,
            chat_send,
            restorable_sessions,
            usage_records,
            read_memory,
            write_memory,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Terminate all agent processes when the app closes.
                let sessions = window.state::<Arc<SessionManager>>();
                sessions.kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running AgentMux");
}
