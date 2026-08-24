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

/// Provider-specific engine behind a chat session.
enum ChatEngine {
    /// Long-lived `claude -p` process speaking bidirectional stream-json.
    Claude {
        stdin: std::process::ChildStdin,
        child: std::process::Child,
    },
    /// Per-turn `codex exec --json` processes; continuity via thread resume.
    Codex {
        cwd: PathBuf,
        model: Option<String>,
        api_key: Option<String>,
        /// Captured from the first turn's thread.started event.
        thread_id: Option<String>,
        /// Restored session: resume the most recent codex thread on first turn.
        resume_last: bool,
        turn: Option<std::process::Child>,
    },
}

/// A structured chat session rendered as bubbles in the UI.
struct ChatSession {
    info: SessionInfo,
    engine: ChatEngine,
    attached: bool,
    /// Completed protocol lines, replayed on attach.
    history: Vec<String>,
    /// Transcript file (in the transcripts dir) once one has been written.
    /// Saved at every turn boundary so restores survive crashes too.
    transcript_file: Option<String>,
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

fn kill_chat_engine(engine: &mut ChatEngine) {
    match engine {
        ChatEngine::Claude { child, .. } => {
            let _ = child.kill();
            let _ = child.wait();
        }
        ChatEngine::Codex { turn, .. } => {
            if let Some(child) = turn.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
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
    /// File name (in the transcripts dir) holding the session's protocol
    /// history, written at app shutdown so restored sessions replay visually.
    #[serde(default)]
    pub transcript: Option<String>,
}

fn default_kind() -> String {
    "terminal".into()
}

fn transcripts_dir() -> PathBuf {
    config_dir().join("transcripts")
}

pub fn load_transcript(name: &str) -> Vec<String> {
    // The name is app-generated (session id), but never allow path escapes.
    if name.contains('/') || name.contains("..") {
        return Vec::new();
    }
    let path = transcripts_dir().join(name);
    let lines = fs::read_to_string(&path)
        .map(|s| s.lines().map(|l| l.to_string()).collect())
        .unwrap_or_default();
    let _ = fs::remove_file(&path);
    lines
}

/// Read the sessions left open by the previous run, then clear the file so a
/// crash mid-run doesn't duplicate the offer. The running app rewrites it as
/// sessions come and go. Transcript files not referenced by any entry are
/// stale (dismissed restores, crashes) and get cleaned up here.
pub fn take_restorable() -> Vec<OpenSession> {
    let path = open_sessions_file();
    let entries: Vec<OpenSession> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let _ = fs::remove_file(&path);
    if let Ok(dir) = fs::read_dir(transcripts_dir()) {
        for file in dir.flatten() {
            let name = file.file_name().to_string_lossy().to_string();
            if !entries
                .iter()
                .any(|e| e.transcript.as_deref() == Some(&name))
            {
                let _ = fs::remove_file(file.path());
            }
        }
    }
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

fn apply_std_auth(cmd: &mut std::process::Command, provider: Provider, auth: &ProviderAuth) {
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
                transcript: None,
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
                    transcript: s.transcript_file.clone(),
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
        transcript: Option<String>,
    ) -> Result<SessionInfo, String> {
        // Restored sessions replay the previous run's transcript, followed by
        // a divider marker.
        let mut history = transcript
            .as_deref()
            .map(load_transcript)
            .unwrap_or_default();
        if !history.is_empty() {
            history.push(serde_json::json!({"type": "restored"}).to_string());
        }
        match project.provider {
            Provider::Claude => self.create_claude_chat(app, project, resume, history),
            Provider::Codex => self.create_codex_chat(project, resume, history),
        }
    }

    fn create_claude_chat(
        self: &Arc<Self>,
        app: &AppHandle,
        project: &Project,
        resume: bool,
        history: Vec<String>,
    ) -> Result<SessionInfo, String> {
        let provider = Provider::Claude;
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
            .arg("--replay-user-messages")
            // Word-by-word streaming; partial events are emitted live but kept
            // out of the replay history.
            .arg("--include-partial-messages");
        if resume {
            cmd.arg("--continue");
        }
        if let Some(model) = project.model.as_deref().filter(|m| !m.is_empty()) {
            cmd.arg("--model").arg(model);
        }
        cmd.current_dir(&project.path);
        cmd.env("TERM", "dumb");
        apply_std_auth(&mut cmd, provider, &config.claude);
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
            engine: ChatEngine::Claude { stdin, child },
            attached: false,
            history,
            transcript_file: None,
            started_at: now_secs(),
        };
        self.chats.lock().unwrap().insert(id.clone(), session);
        self.persist_open();

        self.spawn_stderr_forwarder(app, &id, stderr);

        // Stream protocol lines to the frontend; the session ends with the
        // long-lived claude process.
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
                    if let ChatEngine::Claude { child, .. } = &mut session.engine {
                        let _ = child.wait();
                    }
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

    /// Codex chat sessions have no long-lived process; each user turn runs
    /// `codex exec --json`, resuming the captured thread id.
    fn create_codex_chat(
        self: &Arc<Self>,
        project: &Project,
        resume: bool,
        history: Vec<String>,
    ) -> Result<SessionInfo, String> {
        let provider = Provider::Codex;
        find_cli(cli_name(provider)).ok_or_else(|| {
            format!(
                "The `{}` CLI was not found. Install it first, then try again.",
                cli_name(provider)
            )
        })?;
        let config = load_config();
        let api_key = match config.codex.mode {
            AuthMode::ApiKey => config.codex.api_key.clone().filter(|k| !k.is_empty()),
            _ => None,
        };

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
            engine: ChatEngine::Codex {
                cwd: PathBuf::from(&project.path),
                model: project.model.clone().filter(|m| !m.is_empty()),
                api_key,
                thread_id: None,
                resume_last: resume,
                turn: None,
            },
            attached: false,
            history,
            transcript_file: None,
            started_at: now_secs(),
        };
        self.chats.lock().unwrap().insert(id.clone(), session);
        self.persist_open();
        Ok(info)
    }

    fn spawn_stderr_forwarder(
        self: &Arc<Self>,
        app: &AppHandle,
        id: &str,
        stderr: std::process::ChildStderr,
    ) {
        let manager = Arc::clone(self);
        let app = app.clone();
        let session_id = id.to_string();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                // Skip startup noise the CLIs print when stdin is not a TTY.
                if line.trim().is_empty() || line.contains("Reading additional input from stdin") {
                    continue;
                }
                let event = serde_json::json!({"type": "stderr", "text": line}).to_string();
                manager.push_chat_event(&app, &session_id, event);
            }
        });
    }

    fn push_chat_event(&self, app: &AppHandle, id: &str, line: String) {
        // Partial-message stream events are for live rendering only; keeping
        // them out of history keeps replays compact and duplicate-free.
        // Field order varies between events, so match anywhere in the line:
        // the unescaped sequence cannot occur inside a JSON string value.
        let transient = line.contains("\"type\":\"stream_event\"");
        // Turn boundaries trigger a transcript snapshot so restores survive
        // any kind of shutdown, including crashes and SIGKILL.
        let turn_boundary =
            line.contains("\"type\":\"result\"") || line.contains("\"type\":\"turn.completed\"");
        let (emit, save) = {
            let mut chats = self.chats.lock().unwrap();
            match chats.get_mut(id) {
                Some(session) => {
                    if !transient {
                        session.history.push(line.clone());
                        if session.history.len() > CHAT_HISTORY_LIMIT {
                            let excess = session.history.len() - CHAT_HISTORY_LIMIT;
                            session.history.drain(..excess);
                        }
                    }
                    let save = if turn_boundary && !session.history.is_empty() {
                        let name = format!("{}.jsonl", session.info.id);
                        let _ = fs::create_dir_all(transcripts_dir());
                        if fs::write(transcripts_dir().join(&name), session.history.join("\n"))
                            .is_ok()
                        {
                            session.transcript_file = Some(name);
                        }
                        true
                    } else {
                        false
                    };
                    (session.attached, save)
                }
                None => (false, false),
            }
        };
        if save {
            self.persist_open();
        }
        if emit {
            let _ = app.emit(&format!("chat-event-{id}"), line);
        }
    }

    /// Handle one frontend line for a chat session. Claude: raw stream-json
    /// passthrough. Codex: {"type":"user_text"|"interrupt"} control values.
    pub fn chat_send(
        self: &Arc<Self>,
        app: &AppHandle,
        id: &str,
        line: &str,
    ) -> Result<(), String> {
        let mut chats = self.chats.lock().unwrap();
        let session = chats.get_mut(id).ok_or("No such session")?;
        match &mut session.engine {
            ChatEngine::Claude { stdin, .. } => stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|e| e.to_string()),
            ChatEngine::Codex { turn, .. } => {
                let value: serde_json::Value =
                    serde_json::from_str(line).map_err(|e| e.to_string())?;
                match value.get("type").and_then(|t| t.as_str()) {
                    Some("user_text") => {
                        let text = value
                            .get("text")
                            .and_then(|t| t.as_str())
                            .ok_or("Missing text")?
                            .to_string();
                        if turn.is_some() {
                            return Err("The agent is still working on the previous turn".into());
                        }
                        drop(chats);
                        self.start_codex_turn(app, id, text)
                    }
                    Some("interrupt") => {
                        if let Some(child) = turn.as_mut() {
                            let _ = child.kill();
                        }
                        Ok(())
                    }
                    _ => Err("Unknown codex chat message".into()),
                }
            }
        }
    }

    fn start_codex_turn(
        self: &Arc<Self>,
        app: &AppHandle,
        id: &str,
        text: String,
    ) -> Result<(), String> {
        let cli = find_cli("codex").ok_or("The `codex` CLI was not found")?;
        let mut cmd = std::process::Command::new(cli);
        {
            let mut chats = self.chats.lock().unwrap();
            let session = chats.get_mut(id).ok_or("No such session")?;
            let ChatEngine::Codex {
                cwd,
                model,
                api_key,
                thread_id,
                resume_last,
                ..
            } = &session.engine
            else {
                return Err("Not a codex chat session".into());
            };
            cmd.arg("exec");
            if let Some(thread) = thread_id {
                cmd.arg("resume").arg(thread);
            } else if *resume_last {
                cmd.arg("resume").arg("--last");
            } else if let Some(model) = model {
                cmd.arg("-m").arg(model);
            }
            cmd.arg("--json").arg("--skip-git-repo-check").arg(&text);
            cmd.current_dir(cwd);
            if let Some(key) = api_key {
                cmd.env("OPENAI_API_KEY", key);
            }
            cmd.stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start codex: {e}"))?;
        let stdout = child.stdout.take().ok_or("Failed to open codex stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to open codex stderr")?;

        // Echo the user message into history so replays include it.
        self.push_chat_event(
            app,
            id,
            serde_json::json!({"type": "user_echo", "text": text}).to_string(),
        );

        {
            let mut chats = self.chats.lock().unwrap();
            let session = chats.get_mut(id).ok_or("No such session")?;
            if let ChatEngine::Codex { turn, .. } = &mut session.engine {
                *turn = Some(child);
            }
        }
        self.spawn_stderr_forwarder(app, id, stderr);

        let manager = Arc::clone(self);
        let app = app.clone();
        let session_id = id.to_string();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                // Capture the thread id from the first turn for precise resume.
                if line.starts_with("{\"type\":\"thread.started\"") {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(thread) = value.get("thread_id").and_then(|t| t.as_str()) {
                            let mut chats = manager.chats.lock().unwrap();
                            if let Some(session) = chats.get_mut(&session_id) {
                                if let ChatEngine::Codex { thread_id, .. } = &mut session.engine {
                                    *thread_id = Some(thread.to_string());
                                }
                            }
                        }
                    }
                }
                manager.push_chat_event(&app, &session_id, line);
            }
            // Turn over: reap the child; the session itself stays alive.
            let mut chats = manager.chats.lock().unwrap();
            if let Some(session) = chats.get_mut(&session_id) {
                if let ChatEngine::Codex { turn, .. } = &mut session.engine {
                    if let Some(mut child) = turn.take() {
                        let _ = child.wait();
                    }
                }
            }
        });
        Ok(())
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
                kill_chat_engine(&mut session.engine);
                // Closed deliberately: this session is not restorable, so its
                // transcript snapshot is no longer needed.
                if let Some(name) = &session.transcript_file {
                    let _ = fs::remove_file(transcripts_dir().join(name));
                }
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

    /// Kill every session at app shutdown. The open-sessions file is rewritten
    /// (not cleared) with chat transcript snapshots so the next launch can
    /// restore both the conversations and their visual history.
    pub fn kill_all(&self) {
        {
            let sessions = self.sessions.lock().unwrap();
            let chats = self.chats.lock().unwrap();
            let _ = fs::create_dir_all(transcripts_dir());
            let mut entries: Vec<OpenSession> = sessions
                .values()
                .filter(|s| s.info.running && !s.info.project_id.is_empty())
                .map(|s| OpenSession {
                    project_id: s.info.project_id.clone(),
                    kind: s.info.kind.clone(),
                    transcript: None,
                })
                .collect();
            for session in chats
                .values()
                .filter(|s| s.info.running && !s.info.project_id.is_empty())
            {
                let transcript = if session.history.is_empty() {
                    None
                } else {
                    let name = format!("{}.jsonl", session.info.id);
                    fs::write(transcripts_dir().join(&name), session.history.join("\n"))
                        .ok()
                        .map(|_| name)
                };
                entries.push(OpenSession {
                    project_id: session.info.project_id.clone(),
                    kind: session.info.kind.clone(),
                    transcript,
                });
            }
            let _ = fs::create_dir_all(config_dir());
            if let Ok(json) = serde_json::to_string(&entries) {
                let _ = fs::write(open_sessions_file(), json);
            }
        }
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
            kill_chat_engine(&mut session.engine);
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
