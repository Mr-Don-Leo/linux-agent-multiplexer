import { useEffect, useState } from "react";
import { readMemory, writeMemory, writeSession, encodeInput } from "../ipc";
import type { Project } from "../types";

interface Props {
  project: Project;
  sessionId: string | null;
  onClose: () => void;
}

type Scope = "project" | "global";

/**
 * Agent memory panel: view/edit the project memory file (CLAUDE.md / AGENTS.md)
 * and the user's global memory, plus quick actions that talk to the live session.
 */
export default function MemoryPanel({ project, sessionId, onClose }: Props) {
  const [scope, setScope] = useState<Scope>("project");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    setDirty(false);
    readMemory(scope, project.id)
      .then(setContent)
      .catch(() => setContent(""));
  }, [scope, project.id]);

  const save = async () => {
    await writeMemory(scope, content, project.id);
    setDirty(false);
    setStatus("Saved");
    setTimeout(() => setStatus(null), 1500);
  };

  const sendCommand = async (cmd: string) => {
    if (!sessionId) return;
    await writeSession(sessionId, encodeInput(cmd + "\r"));
    setStatus(`Sent ${cmd}`);
    setTimeout(() => setStatus(null), 1500);
  };

  const memoryFile = project.provider === "claude" ? "CLAUDE.md" : "AGENTS.md";

  return (
    <div className="memory-panel">
      <div className="memory-head">
        <strong>Memory</strong>
        <button className="btn btn-ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="memory-tabs segmented">
        <button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>
          Project ({memoryFile})
        </button>
        <button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>
          Global
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
        }}
        placeholder={
          scope === "project"
            ? "Project-level memory and instructions the agent loads every session."
            : "Global memory shared by all your agents."
        }
      />
      <div className="memory-actions">
        <button className="btn btn-primary" onClick={save} disabled={!dirty}>
          Save
        </button>
        <button
          className="btn"
          onClick={() => sendCommand("/compact")}
          disabled={!sessionId}
          title="Ask the agent to compact its conversation context"
        >
          Compact context
        </button>
        {status && <span className="pill neutral">{status}</span>}
      </div>
    </div>
  );
}
