use crate::config::{load_config, AuthMode, Provider, ProviderAuth};
use crate::projects::Project;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Rolling scrollback kept per session so a re-mounted terminal can replay
/// recent output (e.g. after navigating home and back).
const SCROLLBACK_LIMIT: usize = 256 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub provider: Provider,
    pub running: bool,
}

struct Session {
    info: SessionInfo,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// While detached (no terminal listening), output only accumulates in the
    /// scrollback; on attach the whole scrollback is flushed through the event
    /// channel and live streaming resumes. This avoids losing or duplicating
    /// bytes around mount/unmount races.
    attached: bool,
    scrollback: VecDeque<u8>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    counter: AtomicU64,
}

/// Locate a CLI binary, looking beyond PATH into the usual npm/bun install dirs,
/// since a desktop-launched app often has a minimal PATH.
pub fn find_cli(name: &str) -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let home = dirs::home_dir()?;
    for rel in [
        ".local/bin",
        ".npm-global/bin",
        ".bun/bin",
        ".yarn/bin",
        "bin",
        "node_modules/.bin",
    ] {
        let candidate = home.join(rel).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn cli_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "claude",
        Provider::Codex => "codex",
    }
}

fn api_key_env(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "ANTHROPIC_API_KEY",
        Provider::Codex => "OPENAI_API_KEY",
    }
}

fn apply_auth(cmd: &mut CommandBuilder, provider: Provider, auth: &ProviderAuth) {
    match auth.mode {
        AuthMode::ApiKey => {
            if let Some(key) = auth.api_key.as_deref().filter(|k| !k.is_empty()) {
                cmd.env(api_key_env(provider), key);
            }
        }
        // Make sure a stray API key in the environment doesn't shadow the
        // subscription login.
        AuthMode::Subscription => cmd.env_remove(api_key_env(provider)),
        AuthMode::None => {}
    }
}

impl SessionManager {
    fn next_id(&self, prefix: &str) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{prefix}{n}-{nanos:x}")
    }

    fn spawn(
        self: &Arc<Self>,
        app: &AppHandle,
        id: String,
        info: SessionInfo,
        cmd: CommandBuilder,
    ) -> Result<SessionInfo, String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to start agent: {e}"))?;
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let session = Session {
            info: info.clone(),
            master: pair.master,
            writer,
            killer,
            attached: false,
            scrollback: VecDeque::new(),
        };
        self.sessions.lock().unwrap().insert(id.clone(), session);

        // Reap the child when it exits.
        std::thread::spawn(move || {
            let _ = child.wait();
        });

        // Stream PTY output to the frontend.
        let manager = Arc::clone(self);
        let app = app.clone();
        let session_id = id;
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        let mut emit_payload = None;
                        {
                            let mut sessions = manager.sessions.lock().unwrap();
                            if let Some(session) = sessions.get_mut(&session_id) {
                                session.scrollback.extend(chunk.iter().copied());
                                while session.scrollback.len() > SCROLLBACK_LIMIT {
                                    session.scrollback.pop_front();
                                }
                                if session.attached {
                                    emit_payload = Some(B64.encode(chunk));
                                }
                            } else {
                                break;
                            }
                        }
                        if let Some(payload) = emit_payload {
                            let _ = app.emit(&format!("session-output-{session_id}"), payload);
                        }
                    }
                }
            }
            {
                let mut sessions = manager.sessions.lock().unwrap();
                if let Some(session) = sessions.get_mut(&session_id) {
                    session.info.running = false;
                }
            }
            let _ = app.emit(&format!("session-exit-{session_id}"), ());
        });

        Ok(info)
    }

    pub fn create_for_project(
        self: &Arc<Self>,
        app: &AppHandle,
        project: &Project,
    ) -> Result<SessionInfo, String> {
        let config = load_config();
        let provider = project.provider;
        let cli = find_cli(cli_name(provider)).ok_or_else(|| {
            format!(
                "The `{}` CLI was not found. Install it first, then try again.",
                cli_name(provider)
            )
        })?;

        let mut cmd = CommandBuilder::new(cli);
        if let Some(model) = project.model.as_deref().filter(|m| !m.is_empty()) {
            match provider {
                Provider::Claude => {
                    cmd.arg("--model");
                    cmd.arg(model);
                }
                Provider::Codex => {
                    cmd.arg("-m");
                    cmd.arg(model);
                }
            }
        }
        cmd.cwd(&project.path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let auth = match provider {
            Provider::Claude => &config.claude,
            Provider::Codex => &config.codex,
        };
        apply_auth(&mut cmd, provider, auth);

        let id = self.next_id("s");
        let count = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.info.project_id == project.id)
            .count();
        let title = if count == 0 {
            format!("{} · {}", project.agent_name, project.name)
        } else {
            format!("{} · {} ({})", project.agent_name, project.name, count + 1)
        };
        let info = SessionInfo {
            id: id.clone(),
            project_id: project.id.clone(),
            title,
            provider,
            running: true,
        };
        self.spawn(app, id, info, cmd)
    }

    /// Spawn a terminal running the provider's interactive login flow.
    pub fn create_login(
        self: &Arc<Self>,
        app: &AppHandle,
        provider: Provider,
    ) -> Result<SessionInfo, String> {
        let cli = find_cli(cli_name(provider))
            .ok_or_else(|| format!("The `{}` CLI was not found.", cli_name(provider)))?;
        let mut cmd = CommandBuilder::new(cli);
        match provider {
            Provider::Claude => {
                cmd.arg("/login");
            }
            Provider::Codex => {
                cmd.arg("login");
            }
        }
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env_remove(api_key_env(provider));

        let id = self.next_id("login");
        let info = SessionInfo {
            id: id.clone(),
            project_id: String::new(),
            title: format!("{} login", cli_name(provider)),
            provider,
            running: true,
        };
        self.spawn(app, id, info, cmd)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info.clone())
            .collect()
    }

    pub fn write(&self, id: &str, data_b64: &str) -> Result<(), String> {
        let bytes = B64.decode(data_b64).map_err(|e| e.to_string())?;
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(id).ok_or("No such session")?;
        session
            .writer
            .write_all(&bytes)
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(id).ok_or("No such session")?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// Called by a terminal component after it has subscribed to output events:
    /// replays the scrollback and enables live streaming.
    pub fn attach(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let payload = {
            let mut sessions = self.sessions.lock().unwrap();
            let session = sessions.get_mut(id).ok_or("No such session")?;
            session.attached = true;
            if session.scrollback.is_empty() {
                None
            } else {
                Some(B64.encode(session.scrollback.make_contiguous()))
            }
        };
        if let Some(payload) = payload {
            let _ = app.emit(&format!("session-output-{id}"), payload);
        }
        Ok(())
    }

    pub fn detach(&self, id: &str) {
        if let Some(session) = self.sessions.lock().unwrap().get_mut(id) {
            session.attached = false;
        }
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.killer.kill();
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.killer.kill();
        }
    }
}
