export type Provider = "claude" | "codex";
export type AuthMode = "subscription" | "api_key" | "none";
export type Theme = "system" | "light" | "dark";

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

export interface SessionInfo {
  id: string;
  projectId: string;
  title: string;
  provider: Provider;
  running: boolean;
}

export interface CliStatus {
  installed: boolean;
  version?: string | null;
  path?: string | null;
}

export const CLAUDE_MODELS = ["default", "fable", "opus", "sonnet", "haiku"];
export const CODEX_MODELS = ["default", "gpt-5.1-codex", "gpt-5.1-codex-mini", "o4-mini"];
