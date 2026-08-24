import { useState } from "react";
import type { NewProject, Project, Provider } from "../types";
import { CLAUDE_MODELS, CODEX_MODELS } from "../types";
import Select from "./Select";

interface Props {
  /** When set, the dialog edits this project instead of creating a new one. */
  initial?: Project;
  onCancel: () => void;
  onSave: (project: NewProject) => Promise<void>;
}

export default function CreateProject({ initial, onCancel, onSave }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [agentName, setAgentName] = useState(initial?.agentName ?? "");
  const [githubRepo, setGithubRepo] = useState(initial?.githubRepo ?? "");
  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [port, setPort] = useState(initial?.port != null ? String(initial.port) : "");
  const [provider, setProvider] = useState<Provider>(initial?.provider ?? "claude");
  const [model, setModel] = useState(initial?.model ?? "default");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = initial !== undefined;

  const models = provider === "claude" ? CLAUDE_MODELS : CODEX_MODELS;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        agentName: agentName.trim(),
        githubRepo: githubRepo.trim() || null,
        domain: domain.trim() || null,
        port: port.trim() ? Number(port) : null,
        provider,
        model: model === "default" ? null : model,
        instructions: instructions.trim() || null,
      });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal card">
        <h2>{editing ? "Edit Project" : "New Project"}</h2>
        <div className="row">
          <div className="field">
            <label>Project name *</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" autoFocus />
          </div>
          <div className="field">
            <label>Agent name *</label>
            <input className="input" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Ada" />
          </div>
        </div>
        <div className="field">
          <label>GitHub repository (optional)</label>
          <input className="input" value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="https://github.com/you/repo.git" />
          <span className="hint">
            {editing
              ? "Metadata only — the existing project folder is not moved or re-cloned."
              : "Cloned into the project folder on creation."}
          </span>
        </div>
        <div className="row">
          <div className="field">
            <label>Domain / subdomain (optional)</label>
            <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" />
          </div>
          <div className="field">
            <label>Port (optional)</label>
            <input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="3000" />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>AI provider</label>
            <Select
              value={provider}
              options={[
                { value: "claude", label: "Claude (Claude Code)" },
                { value: "codex", label: "Codex" },
              ]}
              onChange={(value) => {
                setProvider(value as Provider);
                setModel("default");
              }}
            />
          </div>
          <div className="field">
            <label>Model</label>
            <Select
              value={model}
              options={models.map((m) => ({ value: m, label: m }))}
              onChange={setModel}
            />
          </div>
        </div>
        <div className="field">
          <label>Instructions for the agent (optional)</label>
          <textarea
            className="textarea"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Coding style, project context, rules the agent should always follow…"
          />
          <span className="hint">
            {editing
              ? "The memory file on disk is not overwritten — edit it from the session's Memory panel."
              : "Saved as the project's agent memory file (CLAUDE.md / AGENTS.md)."}
          </span>
        </div>
        {error && <span style={{ color: "var(--danger)", fontSize: 12 }}>{error}</span>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !name.trim() || !agentName.trim()}
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}
