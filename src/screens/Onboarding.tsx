import { useEffect, useRef, useState } from "react";
import type { AppConfig, AuthMode, CliStatus, Provider } from "../types";
import { checkCli, createLoginSession, killSession, saveConfig } from "../ipc";
import Avatar, { PRESET_IDS } from "../components/Avatar";
import Terminal from "../components/Terminal";

interface Props {
  config: AppConfig;
  dark: boolean;
  onDone: (config: AppConfig) => void;
}

const PROVIDER_LABELS: Record<Provider, { name: string; sub: string; keyEnv: string }> = {
  claude: { name: "Claude", sub: "Claude subscription (Pro / Max)", keyEnv: "ANTHROPIC_API_KEY" },
  codex: { name: "Codex", sub: "ChatGPT subscription", keyEnv: "OPENAI_API_KEY" },
};

function ProviderSetup({
  provider,
  mode,
  apiKey,
  dark,
  onChange,
}: {
  provider: Provider;
  mode: AuthMode;
  apiKey: string;
  dark: boolean;
  onChange: (mode: AuthMode, apiKey: string) => void;
}) {
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [loginSessionId, setLoginSessionId] = useState<string | null>(null);
  const labels = PROVIDER_LABELS[provider];

  useEffect(() => {
    checkCli(provider).then(setCli).catch(() => setCli({ installed: false }));
  }, [provider]);

  const startLogin = async () => {
    const session = await createLoginSession(provider);
    setLoginSessionId(session.id);
  };

  const closeLogin = () => {
    if (loginSessionId) killSession(loginSessionId).catch(() => {});
    setLoginSessionId(null);
  };

  return (
    <div className="provider-card">
      <div className="provider-head">
        <div className="provider-name">
          {labels.name}
          {cli && (
            <span className={"pill" + (cli.installed ? "" : " neutral")}>
              {cli.installed ? `CLI ${cli.version ?? "installed"}` : "CLI not found"}
            </span>
          )}
        </div>
      </div>
      <div className="segmented">
        {(["none", "subscription", "api_key"] as AuthMode[]).map((m) => (
          <button
            key={m}
            className={mode === m ? "active" : ""}
            onClick={() => onChange(m, apiKey)}
          >
            {m === "none" ? "Skip" : m === "subscription" ? "Subscription" : "API key"}
          </button>
        ))}
      </div>
      {mode === "subscription" && (
        <div className="field">
          <span className="hint">{labels.sub} — sign in through the CLI.</span>
          {loginSessionId ? (
            <>
              <div className="login-terminal card">
                <Terminal sessionId={loginSessionId} dark={dark} onExit={() => setLoginSessionId(null)} />
              </div>
              <button className="btn btn-ghost" onClick={closeLogin}>
                Close login terminal
              </button>
            </>
          ) : (
            <button className="btn" onClick={startLogin} disabled={!cli?.installed}>
              {cli?.installed ? `Sign in to ${labels.name}` : `Install the ${provider} CLI first`}
            </button>
          )}
        </div>
      )}
      {mode === "api_key" && (
        <div className="field">
          <input
            className="input"
            type="password"
            placeholder={labels.keyEnv}
            value={apiKey}
            onChange={(e) => onChange(mode, e.target.value)}
          />
          <span className="hint">
            Stored locally and passed to agent sessions as {labels.keyEnv}.
          </span>
        </div>
      )}
    </div>
  );
}

export default function Onboarding({ config, dark, onDone }: Props) {
  const [username, setUsername] = useState(config.username);
  const [avatar, setAvatar] = useState(config.avatar || PRESET_IDS[0]);
  const [claudeMode, setClaudeMode] = useState<AuthMode>(config.claude.mode);
  const [claudeKey, setClaudeKey] = useState(config.claude.apiKey ?? "");
  const [codexMode, setCodexMode] = useState<AuthMode>(config.codex.mode);
  const [codexKey, setCodexKey] = useState(config.codex.apiKey ?? "");
  const fileRef = useRef<HTMLInputElement>(null);

  const pickImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result));
    reader.readAsDataURL(file);
  };

  const finish = async () => {
    const next: AppConfig = {
      ...config,
      onboarded: true,
      username: username.trim(),
      avatar,
      claude: { mode: claudeMode, apiKey: claudeKey.trim() || null },
      codex: { mode: codexMode, apiKey: codexKey.trim() || null },
    };
    await saveConfig(next);
    onDone(next);
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card card">
        <h1>Welcome to AgentMux</h1>
        <p className="subtitle">Run many coding agents. One place.</p>

        <div className="field">
          <label>Username</label>
          <input
            className="input"
            placeholder="What should your agents call you?"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </div>

        <div className="field">
          <label>Profile picture</label>
          <div className="avatar-row">
            {PRESET_IDS.map((id) => (
              <button
                key={id}
                className={"avatar-option" + (avatar === id ? " selected" : "")}
                onClick={() => setAvatar(id)}
              >
                <Avatar avatar={id} username={username} size={44} />
              </button>
            ))}
            <button
              className={"avatar-option" + (avatar.startsWith("data:") ? " selected" : "")}
              onClick={() => fileRef.current?.click()}
              title="Upload an image"
            >
              {avatar.startsWith("data:") ? (
                <Avatar avatar={avatar} size={44} />
              ) : (
                <div className="avatar" style={{ width: 44, height: 44, background: "var(--bg-input)", color: "var(--text-secondary)" }}>
                  +
                </div>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => e.target.files?.[0] && pickImage(e.target.files[0])}
            />
          </div>
        </div>

        <div className="field">
          <label>Connect your agents</label>
          <span className="hint">
            You can connect a subscription, paste an API key, or skip and set this up later.
          </span>
        </div>
        <ProviderSetup
          provider="claude"
          mode={claudeMode}
          apiKey={claudeKey}
          dark={dark}
          onChange={(m, k) => {
            setClaudeMode(m);
            setClaudeKey(k);
          }}
        />
        <ProviderSetup
          provider="codex"
          mode={codexMode}
          apiKey={codexKey}
          dark={dark}
          onChange={(m, k) => {
            setCodexMode(m);
            setCodexKey(k);
          }}
        />

        <button className="btn btn-primary" onClick={finish} disabled={!username.trim()}>
          Get started
        </button>
      </div>
    </div>
  );
}
