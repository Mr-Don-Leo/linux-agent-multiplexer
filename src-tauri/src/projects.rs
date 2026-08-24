use crate::config::{config_dir, Provider};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub agent_name: String,
    pub path: String,
    #[serde(default)]
    pub github_repo: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub port: Option<u32>,
    pub provider: Provider,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub name: String,
    pub agent_name: String,
    #[serde(default)]
    pub github_repo: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub port: Option<u32>,
    pub provider: Provider,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
}

fn projects_file() -> PathBuf {
    config_dir().join("projects.json")
}

pub fn load_projects() -> Vec<Project> {
    fs::read_to_string(projects_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn store_projects(projects: &[Project]) -> Result<(), String> {
    fs::create_dir_all(config_dir()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(projects).map_err(|e| e.to_string())?;
    fs::write(projects_file(), json).map_err(|e| e.to_string())
}

fn sanitize_dir_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "project".into()
    } else {
        cleaned
    }
}

pub fn memory_file_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "CLAUDE.md",
        Provider::Codex => "AGENTS.md",
    }
}

fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("p{nanos:x}")
}

pub fn create_project(spec: NewProject) -> Result<Project, String> {
    if spec.name.trim().is_empty() {
        return Err("Project name is required".into());
    }
    if spec.agent_name.trim().is_empty() {
        return Err("Agent name is required".into());
    }

    let root = dirs::home_dir()
        .ok_or("Could not resolve home directory")?
        .join("AgentMux");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = root.join(sanitize_dir_name(&spec.name));

    if let Some(repo) = spec.github_repo.as_deref().filter(|r| !r.is_empty()) {
        if path.exists() {
            return Err(format!(
                "Folder {} already exists; cannot clone into it",
                path.display()
            ));
        }
        let output = Command::new("git")
            .arg("clone")
            .arg(repo)
            .arg(&path)
            .output()
            .map_err(|e| format!("Failed to run git: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "git clone failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    } else {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }

    // Seed the agent's project memory file with identity + instructions.
    let memory_path = path.join(memory_file_name(spec.provider));
    if !memory_path.exists() {
        let mut memory = format!(
            "# {}\n\nYou are {}, the dedicated agent for this project.\n",
            spec.name, spec.agent_name
        );
        if let Some(domain) = spec.domain.as_deref().filter(|d| !d.is_empty()) {
            memory.push_str(&format!("\nDeployment domain: {domain}\n"));
        }
        if let Some(port) = spec.port {
            memory.push_str(&format!("App port: {port}\n"));
        }
        if let Some(instructions) = spec.instructions.as_deref().filter(|i| !i.is_empty()) {
            memory.push_str(&format!("\n## Instructions\n\n{instructions}\n"));
        }
        fs::write(&memory_path, memory).map_err(|e| e.to_string())?;
    }

    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let project = Project {
        id: new_id(),
        name: spec.name.trim().to_string(),
        agent_name: spec.agent_name.trim().to_string(),
        path: path.to_string_lossy().to_string(),
        github_repo: spec.github_repo.filter(|r| !r.is_empty()),
        domain: spec.domain.filter(|d| !d.is_empty()),
        port: spec.port,
        provider: spec.provider,
        model: spec.model.filter(|m| !m.is_empty()),
        instructions: spec.instructions.filter(|i| !i.is_empty()),
        created_at: created.to_string(),
    };

    let mut projects = load_projects();
    projects.push(project.clone());
    store_projects(&projects)?;
    Ok(project)
}

pub fn delete_project(id: &str) -> Result<(), String> {
    let mut projects = load_projects();
    projects.retain(|p| p.id != id);
    store_projects(&projects)
    // The project folder is intentionally left on disk.
}
