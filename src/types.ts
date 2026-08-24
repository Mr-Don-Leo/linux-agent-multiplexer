export type Provider = "claude" | "codex";
export type AuthMode = "subscription" | "api_key" | "none";
export type Theme = "system" | "light" | "dark";
export type Skin = "apple" | "cyberpunk" | "xp";

export const SKINS: { id: Skin; name: string; blurb: string; hasModes: boolean }[] = [
  { id: "apple", name: "Modern", blurb: "Clean, native, HIG-inspired", hasModes: true },
  { id: "cyberpunk", name: "Cyberpunk", blurb: "Neon grid, retro-futurist", hasModes: false },
  { id: "xp", name: "Retro XP", blurb: "Luna blue, 2001 nostalgia", hasModes: false },
];

export interface ProviderAuth {
  mode: AuthMode;
  /** Stored locally in the user's config dir; injected into agent sessions as an env var. */
  apiKey?: string | null;
}

export interface AppConfig {
  onboarded: boolean;
  username: string;
  /** Either a preset id ("preset:3") or a data URL for an uploaded image. */
  avatar: string;
  theme: Theme;
  skin: Skin;
  notifications: boolean;
  claude: ProviderAuth;
  codex: ProviderAuth;
}

export interface Project {
  id: string;
  name: string;
  agentName: string;
  path: string;
  githubRepo?: string | null;
  domain?: string | null;
  port?: number | null;
  provider: Provider;
  model?: string | null;
  instructions?: string | null;
  createdAt: string;
}

export interface NewProject {
  name: string;
  agentName: string;
  githubRepo?: string | null;
  domain?: string | null;
  port?: number | null;
  provider: Provider;
  model?: string | null;
  instructions?: string | null;
}

export type SessionKind = "chat" | "terminal";

/** Per-session approval policy for agent permission requests. */
export type ApprovalMode = "ask" | "edits" | "all";

export const APPROVAL_MODES: { value: ApprovalMode; label: string }[] = [
  { value: "ask", label: "Ask to approve" },
  { value: "edits", label: "Auto-approve edits" },
  { value: "all", label: "Auto-approve all" },
];

export interface SessionInfo {
  id: string;
  projectId: string;
  title: string;
  provider: Provider;
  kind: SessionKind;
  running: boolean;
}

export interface RestorableSession {
  projectId: string;
  kind: SessionKind;
}

export interface UsageRecord {
  provider: Provider;
  projectId: string;
  startedAt: number;
  seconds: number;
}

export interface CliStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
}

export const CLAUDE_MODELS = ["default", "fable", "opus", "sonnet", "haiku"];
export const CODEX_MODELS = ["default", "gpt-5.1-codex", "gpt-5.1-codex-mini", "o4-mini"];
