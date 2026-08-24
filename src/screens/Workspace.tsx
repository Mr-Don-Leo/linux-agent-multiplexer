import { useState } from "react";
import type { Project, SessionInfo } from "../types";
import Terminal from "../components/Terminal";
import MemoryPanel from "../components/MemoryPanel";

interface Props {
  dark: boolean;
  projects: Project[];
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewSession: (project: Project) => void;
  onCloseSession: (id: string) => void;
  onSessionExit: (id: string) => void;
  onBack: () => void;
}

/**
 * The multiplexer view: every session keeps its Terminal mounted so scrollback
 * and live output survive switching; only the active one is visible.
 */
export default function Workspace({
  dark,
  projects,
  sessions,
  activeSessionId,
  onSelect,
  onNewSession,
  onCloseSession,
  onSessionExit,
  onBack,
}: Props) {
  const [showMemory, setShowMemory] = useState(false);

  const active = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeProject = active ? projects.find((p) => p.id === active.projectId) ?? null : null;

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-head">
          <button className="btn btn-ghost" onClick={onBack}>
            ← Projects
          </button>
          <strong style={{ fontSize: 13 }}>Sessions</strong>
        </div>
        <div className="session-list">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={"session-item" + (s.id === activeSessionId ? " active" : "")}
              onClick={() => onSelect(s.id)}
            >
              <span className={"dot" + (s.running ? "" : " dead")} />
              <span className="session-title">{s.title}</span>
              <span
                className="close"
                title="Close session"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseSession(s.id);
                }}
              >
                ✕
              </span>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="empty-state" style={{ padding: 24 }}>
              <span>No sessions yet</span>
            </div>
          )}
        </div>
        <div style={{ padding: 10, borderTop: "1px solid var(--border)" }}>
          {activeProject && (
            <button className="btn" style={{ width: "100%" }} onClick={() => onNewSession(activeProject)}>
              + New session · {activeProject.name}
            </button>
          )}
        </div>
      </aside>

      <main className="workspace-main">
        {active && activeProject ? (
          <>
            <div className="workspace-toolbar">
              <span className="title">
                {active.title}
                <span className="pill neutral" style={{ marginLeft: 10 }}>
                  {activeProject.provider === "claude" ? "Claude" : "Codex"}
                  {activeProject.model ? ` · ${activeProject.model}` : ""}
                </span>
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className={"btn" + (showMemory ? " btn-primary" : "")}
                  onClick={() => setShowMemory(!showMemory)}
                >
                  Memory
                </button>
              </div>
            </div>
            <div className="terminal-area">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: s.id === activeSessionId ? "flex" : "none",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  <Terminal sessionId={s.id} dark={dark} onExit={() => onSessionExit(s.id)} />
                </div>
              ))}
              {showMemory && (
                <MemoryPanel
                  project={activeProject}
                  sessionId={active.running ? active.id : null}
                  onClose={() => setShowMemory(false)}
                />
              )}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <span className="big">⌘</span>
            <span>Select a session, or open a project to start one.</span>
          </div>
        )}
      </main>
    </div>
  );
}
