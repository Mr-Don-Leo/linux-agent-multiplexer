use crate::config::{config_dir, load_config, AuthMode, Provider, ProviderAuth};
use crate::projects::Project;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// "chat" (structured stream-json UI) or "terminal" (PTY + xterm).
    pub kind: String,
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
    started_at: u64,
}

/// A structured chat session: `claude -p` speaking the bidirectional
/// stream-json protocol over plain pipes. Lines of JSON in both directions.
struct ChatSession {
    info: SessionInfo,
    stdin: std::process::ChildStdin,
    child: std::process::Child,
    attached: bool,
    /// Completed protocol lines, replayed on attach.
    history: Vec<String>,
    started_at: u64,
}

const CHAT_HISTORY_LIMIT: usize = 4000;

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    chats: Mutex<HashMap<String, ChatSession>>,
    counter: AtomicU64,
    shutting_down: AtomicBool,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- Session persistence (restore-on-next-launch) ----------

fn open_sessions_file() -> PathBuf {
    config_dir().join("open-sessions.json")
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSession {
    pub project_id: String,
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "terminal".into()
}

/// Read the sessions left open by the previous run, then clear the file so a
/// crash mid-run doesn't duplicate the offer. The running app rewrites it as
/// sessions come and go.
pub fn take_restorable() -> Vec<OpenSession> {
    let path = open_sessions_file();
    let entries: Vec<OpenSession> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let _ = fs::remove_file(&path);
    entries
}

// ---------- Usage tracking ----------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub provider: Provider,
    pub project_id: String,
    pub started_at: u64,
    pub seconds: u64,
}

fn usage_file() -> PathBuf {
    config_dir().join("usage.json")
}

pub fn load_usage() -> Vec<UsageRecord> {
    fs::read_to_string(usage_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn record_usage(provider: Provider, project_id: &str, started_at: u64) {
    if project_id.is_empty() {
        return; // login helpers don't count
    }
    let mut records = load_usage();
    records.push(UsageRecord {
        provider,
        project_id: project_id.to_string(),
        started_at,
        seconds: now_secs().saturating_sub(started_at),
    });
    // Keep the file bounded; ~5000 sessions of history is plenty.
    if records.len() > 5000 {
        let excess = records.len() - 5000;
        records.drain(..excess);
    }
    let _ = fs::create_dir_all(config_dir());
    if let Ok(json) = serde_json::to_string(&records) {
        let _ = fs::write(usage_file(), json);
    }
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
    /// Rewrite open-sessions.json with the live project sessions (one entry per
    /// session, duplicates meaningful). No-op during shutdown so dying reader
    /// threads can't wipe the file the next launch restores from.
    fn persist_open(&self) {
        if self.shutting_down.load(Ordering::Relaxed) {
            return;
        }
        let mut entries: Vec<OpenSession> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.info.running && !s.info.project_id.is_empty())
            .map(|s| OpenSession {
                project_id: s.info.project_id.clone(),
                kind: s.info.kind.clone(),
            })
            .collect();
        entries.extend(
            self.chats
                .lock()
                .unwrap()
                .values()
                .filter(|s| s.info.running && !s.info.project_id.is_empty())
                .map(|s| OpenSession {
                    project_id: s.info.project_id.clone(),
                    kind: s.info.kind.clone(),
                }),
        );
        let _ = fs::create_dir_all(config_dir());
        if let Ok(json) = serde_json::to_string(&entries) {
            let _ = fs::write(open_sessions_file(), json);
        }
    }

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
            started_at: now_secs(),
        };
        self.sessions.lock().unwrap().insert(id.clone(), session);
        self.persist_open();

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
                    record_usage(
                        session.info.provider,
                        &session.info.project_id,
                        session.started_at,
                    );
                }
            }
            manager.persist_open();
            let _ = app.emit(&format!("session-exit-{session_id}"), ());
        });

        Ok(info)
    }

    pub fn create_for_project(
        self: &Arc<Self>,
        app: &AppHandle,
        project: &Project,
        resume: bool,
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
        match (provider, resume) {
            (Provider::Claude, true) => {
                cmd.arg("--continue");
            }
            (Provider::Codex, true) => {
                cmd.arg("resume");
                cmd.arg("--last");
            }
            _ => {}
        }
        if let Some(model) = project.model.as_deref().filter(|m| !m.is_empty()) {
            match provider {
                Provider::Claude => {
                    cmd.arg("--model");
                    cmd.arg(model);
                }
                // `codex resume` doesn't take a model override.
                Provider::Codex if !resume => {
                    cmd.arg("-m");
                    cmd.arg(model);
                }
                Provider::Codex => {}
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
        let info = SessionInfo {
            id: id.clone(),
            project_id: project.id.clone(),
            title: self.session_title(project),
            provider,
            kind: "terminal".into(),
            running: true,
        };
        self.spawn(app, id, info, cmd)
    }

    fn session_title(&self, project: &Project) -> String {
        let count = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.info.project_id == project.id)
            .count()
            + self
                .chats
                .lock()
                .unwrap()
                .values()
                .filter(|s| s.info.project_id == project.id)
                .count();
        if count == 0 {
            format!("{} · {}", project.agent_name, project.name)
        } else {
            format!("{} · {} ({})", project.agent_name, project.name, count + 1)
        }
    }

    /// Spawn a structured chat session speaking stream-json over pipes.
    pub fn create_chat_for_project(
        self: &Arc<Self>,
        app: &AppHandle,
        project: &Project,
        resume: bool,
    ) -> Result<SessionInfo, String> {
        let provider = project.provider;
        if provider != Provider::Claude {
            return Err("Chat mode is currently available for Claude sessions only".into());
        }
        let config = load_config();
        let cli = find_cli(cli_name(provider)).ok_or_else(|| {
            format!(
                "The `{}` CLI was not found. Install it first, then try again.",
                cli_name(provider)
            )
        })?;

        let mut cmd = std::process::Command::new(cli);
        cmd.arg("-p")
            .arg("--verbose")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--permission-prompt-tool")
            .arg("stdio")
            // Echo user messages back on stdout so they land in the history
            // replayed to re-mounted chat views.
            .arg("--replay-user-messages");
        if resume {
            cmd.arg("--continue");
        }
        if let Some(model) = project.model.as_deref().filter(|m| !m.is_empty()) {
            cmd.arg("--model").arg(model);
        }
        cmd.current_dir(&project.path);
        cmd.env("TERM", "dumb");
        let auth = &config.claude;
        match auth.mode {
            AuthMode::ApiKey => {
                if let Some(key) = auth.api_key.as_deref().filter(|k| !k.is_empty()) {
                    cmd.env(api_key_env(provider), key);
                }
            }
            AuthMode::Subscription => {
                cmd.env_remove(api_key_env(provider));
            }
            AuthMode::None => {}
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start agent: {e}"))?;
        let stdin = child.stdin.take().ok_or("Failed to open agent stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open agent stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to open agent stderr")?;

        let id = self.next_id("c");
        let info = SessionInfo {
            id: id.clone(),
            project_id: project.id.clone(),
            title: self.session_title(project),
            provider,
            kind: "chat".into(),
            running: true,
        };

        let session = ChatSession {
            info: info.clone(),
            stdin,
            child,
            attached: false,
            history: Vec::new(),
            started_at: now_secs(),
        };
        self.chats.lock().unwrap().insert(id.clone(), session);
        self.persist_open();

        // Surface agent stderr as synthetic protocol events.
        {
            let manager = Arc::clone(self);
            let app = app.clone();
            let session_id = id.clone();
            std::thread::spawn(move || {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let event = serde_json::json!({"type": "stderr", "text": line}).to_string();
                    manager.push_chat_event(&app, &session_id, event);
                }
            });
        }

        // Stream protocol lines to the frontend.
        let manager = Arc::clone(self);
        let app = app.clone();
        let session_id = id;
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                manager.push_chat_event(&app, &session_id, line);
            }
            {
                let mut chats = manager.chats.lock().unwrap();
                if let Some(session) = chats.get_mut(&session_id) {
                    session.info.running = false;
                    let _ = session.child.wait();
                    record_usage(
                        session.info.provider,
                        &session.info.project_id,
                        session.started_at,
                    );
                }
            }
            manager.persist_open();
            let _ = app.emit(&format!("session-exit-{session_id}"), ());
        });

        Ok(info)
    }

    fn push_chat_event(&self, app: &AppHandle, id: &str, line: String) {
        let emit = {
            let mut chats = self.chats.lock().unwrap();
            match chats.get_mut(id) {
                Some(session) => {
                    session.history.push(line.clone());
                    if session.history.len() > CHAT_HISTORY_LIMIT {
                        let excess = session.history.len() - CHAT_HISTORY_LIMIT;
                        session.history.drain(..excess);
                    }
                    session.attached
                }
                None => false,
            }
        };
        if emit {
            let _ = app.emit(&format!("chat-event-{id}"), line);
        }
    }

    /// Write one raw protocol line (user message or control response) to a
    /// chat session's stdin.
    pub fn chat_send(&self, id: &str, line: &str) -> Result<(), String> {
        let mut chats = self.chats.lock().unwrap();
        let session = chats.get_mut(id).ok_or("No such session")?;
        session
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| session.stdin.write_all(b"\n"))
            .and_then(|_| session.stdin.flush())
            .map_err(|e| e.to_string())
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
            kind: "terminal".into(),
            running: true,
        };
        self.spawn(app, id, info, cmd)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut infos: Vec<SessionInfo> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info.clone())
            .collect();
        infos.extend(self.chats.lock().unwrap().values().map(|s| s.info.clone()));
        infos
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

    /// Called by a session view after it has subscribed to events: replays the
    /// scrollback (terminal) or protocol history (chat), then enables live
    /// streaming.
    pub fn attach(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        {
            let mut chats = self.chats.lock().unwrap();
            if let Some(session) = chats.get_mut(id) {
                session.attached = true;
                let history = session.history.clone();
                drop(chats);
                let _ = app.emit(&format!("chat-history-{id}"), history);
                return Ok(());
            }
        }
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
        if let Some(session) = self.chats.lock().unwrap().get_mut(id) {
            session.attached = false;
        }
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(mut session) = sessions.remove(id) {
                let _ = session.killer.kill();
                if session.info.running {
                    record_usage(
                        session.info.provider,
                        &session.info.project_id,
                        session.started_at,
                    );
                }
            }
        }
        {
            let mut chats = self.chats.lock().unwrap();
            if let Some(mut session) = chats.remove(id) {
                let _ = session.child.kill();
                let _ = session.child.wait();
                if session.info.running {
                    record_usage(
                        session.info.provider,
                        &session.info.project_id,
                        session.started_at,
                    );
                }
            }
        }
        self.persist_open();
        Ok(())
    }

    /// Kill every session at app shutdown. Deliberately does NOT clear the
    /// open-sessions file: those sessions are what the next launch offers to
    /// restore.
    pub fn kill_all(&self) {
        self.shutting_down.store(true, Ordering::Relaxed);
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.killer.kill();
            if session.info.running {
                record_usage(
                    session.info.provider,
                    &session.info.project_id,
                    session.started_at,
                );
            }
        }
        drop(sessions);
        let mut chats = self.chats.lock().unwrap();
        for (_, mut session) in chats.drain() {
            let _ = session.child.kill();
            let _ = session.child.wait();
            if session.info.running {
                record_usage(
                    session.info.provider,
                    &session.info.project_id,
                    session.started_at,
                );
            }
        }
    }
}
