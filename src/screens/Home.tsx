import { useState } from "react";
import type { AppConfig, NewProject, Project, Theme } from "../types";
import Avatar from "../components/Avatar";
import CreateProject from "../components/CreateProject";

interface Props {
  config: AppConfig;
  projects: Project[];
  onCreate: (p: NewProject) => Promise<void>;
  onDelete: (id: string) => void;
  onOpen: (project: Project) => void;
  onTheme: (theme: Theme) => void;
  activeSessionCount: number;
  onGoWorkspace: () => void;
}

const TILE_COLORS = [
  "linear-gradient(135deg, #5e5ce6, #0a84ff)",
  "linear-gradient(135deg, #ff375f, #ff9f0a)",
  "linear-gradient(135deg, #30d158, #64d2ff)",
  "linear-gradient(135deg, #bf5af2, #ff375f)",
  "linear-gradient(135deg, #ff9f0a, #ffd60a)",
  "linear-gradient(135deg, #64d2ff, #5e5ce6)",
];

function tileColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TILE_COLORS[Math.abs(hash) % TILE_COLORS.length];
}

export default function Home({
  config,
  projects,
  onCreate,
  onDelete,
  onOpen,
  onTheme,
  activeSessionCount,
  onGoWorkspace,
}: Props) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="home">
      <header className="topbar">
        <div className="brand">
          <Avatar avatar={config.avatar} username={config.username} size={30} />
          AgentMux
          <span className="pill neutral">{config.username}</span>
        </div>
        <div className="actions">
          {activeSessionCount > 0 && (
            <button className="btn" onClick={onGoWorkspace}>
              {activeSessionCount} running session{activeSessionCount > 1 ? "s" : ""} →
            </button>
          )}
          <button
            className="btn btn-ghost"
            title="Toggle theme"
            onClick={() => onTheme(config.theme === "dark" ? "light" : "dark")}
          >
            {config.theme === "dark" ? "☀︎" : "☾"}
          </button>
        </div>
      </header>

      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className="project-tile card" onClick={() => onOpen(p)}>
            <button
              className="tile-delete"
              title="Delete project"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete project "${p.name}"? The project folder is kept on disk.`)) {
                  onDelete(p.id);
                }
              }}
            >
              ✕
            </button>
            <div className="tile-icon" style={{ background: tileColor(p.id) }}>
              ⌘
            </div>
            <div>
              <div className="tile-name">{p.name}</div>
              <div className="tile-meta">
                <span>
                  {p.agentName} · {p.provider === "claude" ? "Claude" : "Codex"}
                  {p.model ? ` · ${p.model}` : ""}
                </span>
                {p.domain && <span>{p.domain}{p.port ? `:${p.port}` : ""}</span>}
              </div>
            </div>
          </div>
        ))}

        <div className="project-tile card new-tile" onClick={() => setCreating(true)}>
          <div className="plus">+</div>
          <span>New Project</span>
        </div>
      </div>

      {creating && (
        <CreateProject
          onCancel={() => setCreating(false)}
          onCreate={async (p) => {
            await onCreate(p);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}
