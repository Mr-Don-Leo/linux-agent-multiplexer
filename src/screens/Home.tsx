import { useState } from "react";
import type { AppConfig, NewProject, Project, Skin, Theme } from "../types";
import Avatar from "../components/Avatar";
import CreateProject from "../components/CreateProject";
import ThemeGallery from "../components/ThemeGallery";
import UsagePanel from "../components/UsagePanel";

interface Props {
  config: AppConfig;
  projects: Project[];
  onCreate: (p: NewProject) => Promise<void>;
  onUpdate: (id: string, p: NewProject) => Promise<void>;
  onDelete: (id: string) => void;
  onOpen: (project: Project) => void;
  onTheme: (theme: Theme) => void;
  onSkin: (skin: Skin) => void;
  restorableCount: number;
  onRestore: () => void;
  onDismissRestore: () => void;
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
  onUpdate,
  onDelete,
  onOpen,
  onTheme,
  onSkin,
  restorableCount,
  onRestore,
  onDismissRestore,
  activeSessionCount,
  onGoWorkspace,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [showThemes, setShowThemes] = useState(false);
  const [showUsage, setShowUsage] = useState(false);

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
          <button className="btn btn-ghost" title="Usage" onClick={() => setShowUsage(true)}>
            Usage
          </button>
          <button
            className="btn btn-ghost"
            title="Appearance"
            onClick={() => setShowThemes(true)}
          >
            Themes
          </button>
        </div>
      </header>

      {restorableCount > 0 && (
        <div className="restore-banner card">
          <span className="grow">
            {restorableCount} session{restorableCount > 1 ? "s were" : " was"} open last time.
            Resume where the agents left off?
          </span>
          <button className="btn btn-primary" onClick={onRestore}>
            Restore
          </button>
          <button className="btn btn-ghost" onClick={onDismissRestore}>
            Dismiss
          </button>
        </div>
      )}

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
            <button
              className="tile-delete tile-edit"
              title="Edit project"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(p);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="m11.3 2.7 2 2L5.5 12.5l-2.8.8.8-2.8 7.8-7.8Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
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
                {p.domain && (
                  <span>
                    {p.domain}
                    {p.port ? `:${p.port}` : ""}
                  </span>
                )}
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
          onSave={async (p) => {
            await onCreate(p);
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <CreateProject
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={async (p) => {
            await onUpdate(editing.id, p);
            setEditing(null);
          }}
        />
      )}
      {showThemes && (
        <ThemeGallery
          skin={config.skin}
          theme={config.theme}
          onSelect={onSkin}
          onTheme={onTheme}
          onClose={() => setShowThemes(false)}
        />
      )}
      {showUsage && <UsagePanel projects={projects} onClose={() => setShowUsage(false)} />}
    </div>
  );
}
