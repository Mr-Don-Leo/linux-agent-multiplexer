import { useState } from "react";
import type { NewProject, Provider } from "../types";
import { CLAUDE_MODELS, CODEX_MODELS } from "../types";

interface Props {
  onCancel: () => void;
  onCreate: (project: NewProject) => Promise<void>;
}

export default function CreateProject({ onCancel, onCreate }: Props) {
  const [name, setName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [domain, setDomain] = useState("");
  const [port, setPort] = useState("");
  const [provider, setProvider] = useState<Provider>("claude");
  const [model, setModel] = useState("default");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const models = provider === "claude" ? CLAUDE_MODELS : CODEX_MODELS;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCreate({
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
        <h2>New Project</h2>
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
          <span className="hint">Cloned into the project folder on creation.</span>
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
            <select
              className="select"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as Provider);
                setModel("default");
              }}
            >
              <option value="claude">Claude (Claude Code)</option>
              <option value="codex">Codex</option>
            </select>
          </div>
          <div className="field">
            <label>Model</label>
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
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
          <span className="hint">Saved as the project's agent memory file (CLAUDE.md / AGENTS.md).</span>
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
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}
