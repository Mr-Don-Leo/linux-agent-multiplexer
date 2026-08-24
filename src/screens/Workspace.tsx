import { useState } from "react";
import type { Project, SessionInfo, SessionKind, Skin } from "../types";
import type { DetectedPrompt } from "../prompt";
import { encodeInput, writeSession } from "../ipc";
import Terminal from "../components/Terminal";
import ChatView from "../components/ChatView";
import MemoryPanel from "../components/MemoryPanel";

const MAX_PANES = 4;

interface Props {
  skin: Skin;
  dark: boolean;
  projects: Project[];
  sessions: SessionInfo[];
  /** Session ids currently visible, in pane order. */
  panes: string[];
  focusedId: string | null;
  onPanesChange: (panes: string[], focusedId: string | null) => void;
  onNewSession: (project: Project, kind: SessionKind) => void;
  onCloseSession: (id: string) => void;
  onSessionExit: (id: string) => void;
  onPrompt: (sessionId: string, prompt: DetectedPrompt | null) => void;
  onAttention: (sessionId: string, text: string) => void;
  prompts: Record<string, DetectedPrompt>;
  onBack: () => void;
}

/**
 * The multiplexer view. Up to MAX_PANES sessions are visible at once in a grid;
 * hidden sessions keep running in the backend and replay their scrollback when
 * shown again.
 */
export default function Workspace({
  skin,
  dark,
  projects,
  sessions,
  panes,
  focusedId,
  onPanesChange,
  onNewSession,
  onCloseSession,
  onSessionExit,
  onPrompt,
  onAttention,
  prompts,
  onBack,
}: Props) {
  const [showMemory, setShowMemory] = useState(false);

  const focused = sessions.find((s) => s.id === focusedId) ?? null;
  const focusedProject = focused
    ? projects.find((p) => p.id === focused.projectId) ?? null
    : null;

  const selectSolo = (id: string) => onPanesChange([id], id);
  const addSplit = (id: string) => {
    if (panes.includes(id)) return onPanesChange(panes, id);
    if (panes.length >= MAX_PANES) return;
    onPanesChange([...panes, id], id);
  };
  const closePane = (id: string) => {
    const next = panes.filter((p) => p !== id);
    onPanesChange(next, focusedId === id ? next[next.length - 1] ?? null : focusedId);
  };

  const answerPrompt = (sessionId: string, key: string) => {
    writeSession(sessionId, encodeInput(key)).catch(() => {});
    onPrompt(sessionId, null);
  };

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
              className={"session-item" + (panes.includes(s.id) ? " active" : "")}
              onClick={() => selectSolo(s.id)}
              title={s.title}
            >
              <span className={"dot" + (s.running ? "" : " dead")} />
              <span className="session-title">{s.title}</span>
              {!panes.includes(s.id) && panes.length > 0 && panes.length < MAX_PANES && (
                <span
                  className="split-add"
                  title="Open in split view"
                  onClick={(e) => {
                    e.stopPropagation();
                    addSplit(s.id);
                  }}
                >
                  ⊞
                </span>
              )}
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
        <div
          style={{
            padding: 10,
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {focusedProject && (
            <>
              {focusedProject.provider === "claude" && (
                <button
                  className="btn"
                  style={{ width: "100%" }}
                  onClick={() => onNewSession(focusedProject, "chat")}
                >
                  + Chat · {focusedProject.name}
                </button>
              )}
              <button
                className="btn"
                style={{ width: "100%" }}
                onClick={() => onNewSession(focusedProject, "terminal")}
              >
                + Terminal · {focusedProject.name}
              </button>
            </>
          )}
        </div>
      </aside>

      <main className="workspace-main">
        {panes.length > 0 ? (
          <>
            <div className="workspace-toolbar">
              <span className="title">
                {focused?.title ?? ""}
                {focusedProject && (
                  <span className="pill neutral" style={{ marginLeft: 10 }}>
                    {focusedProject.provider === "claude" ? "Claude" : "Codex"}
                    {focusedProject.model ? ` · ${focusedProject.model}` : ""}
                  </span>
                )}
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
              <div className={`pane-grid panes-${panes.length}`}>
                {panes.map((id) => {
                  const session = sessions.find((s) => s.id === id);
                  if (!session) return null;
                  const prompt = prompts[id];
                  return (
                    <div
                      key={id}
                      className={"pane" + (id === focusedId ? " focused" : "")}
                      onMouseDown={() => onPanesChange(panes, id)}
                    >
                      {panes.length > 1 && (
                        <div className="pane-head">
                          <span className={"dot" + (session.running ? "" : " dead")} />
                          <span className="pane-title">{session.title}</span>
                          <button title="Remove from split" onClick={() => closePane(id)}>
                            ✕
                          </button>
                        </div>
                      )}
                      {session.kind === "chat" ? (
                        <ChatView
                          sessionId={id}
                          running={session.running}
                          onAttention={(text) => onAttention(id, text)}
                        />
                      ) : (
                        <Terminal
                          sessionId={id}
                          skin={skin}
                          dark={dark}
                          onExit={() => onSessionExit(id)}
                          onPrompt={(p) => onPrompt(id, p)}
                        />
                      )}
                      {session.kind === "terminal" && prompt && session.running && (
                        <div className="approval-card card">
                          <div className="approval-q">
                            {prompt.question || "The agent is asking:"}
                          </div>
                          <div className="approval-actions">
                            {prompt.options.map((o) => (
                              <button
                                key={o.key}
                                className={"btn" + (o.key === "1" ? " btn-primary" : "")}
                                onClick={() => answerPrompt(id, o.key)}
                              >
                                {o.key}. {o.label}
                              </button>
                            ))}
                            <button
                              className="btn btn-ghost"
                              title="Dismiss (answer in the terminal instead)"
                              onClick={() => onPrompt(id, null)}
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {showMemory && focusedProject && focused && (
                <MemoryPanel
                  project={focusedProject}
                  sessionId={focused.running ? focused.id : null}
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
