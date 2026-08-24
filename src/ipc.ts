import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig, CliStatus, NewProject, Project, Provider, SessionInfo } from "./types";

export const getConfig = () => invoke<AppConfig>("get_config");
export const saveConfig = (config: AppConfig) => invoke<void>("save_config", { config });

export const listProjects = () => invoke<Project[]>("list_projects");
export const createProject = (project: NewProject) => invoke<Project>("create_project", { project });
export const deleteProject = (id: string) => invoke<void>("delete_project", { id });

export const checkCli = (provider: Provider) => invoke<CliStatus>("check_cli", { provider });

export const createSession = (projectId: string) =>
  invoke<SessionInfo>("session_create", { projectId });
export const createLoginSession = (provider: Provider) =>
  invoke<SessionInfo>("session_create_login", { provider });
export const listSessions = () => invoke<SessionInfo[]>("session_list");
export const writeSession = (id: string, data: string) =>
  invoke<void>("session_write", { id, data });
export const resizeSession = (id: string, cols: number, rows: number) =>
  invoke<void>("session_resize", { id, cols, rows });
export const killSession = (id: string) => invoke<void>("session_kill", { id });
/** Replay scrollback and start live output streaming. Call after subscribing to output events. */
export const attachSession = (id: string) => invoke<void>("session_attach", { id });
export const detachSession = (id: string) => invoke<void>("session_detach", { id });

export const readMemory = (scope: "project" | "global", projectId?: string) =>
  invoke<string>("read_memory", { scope, projectId: projectId ?? null });
export const writeMemory = (scope: "project" | "global", content: string, projectId?: string) =>
  invoke<void>("write_memory", { scope, content, projectId: projectId ?? null });

/** Subscribe to raw PTY output for a session. Payload is base64-encoded bytes. */
export const onSessionOutput = (id: string, handler: (bytes: Uint8Array) => void): Promise<UnlistenFn> =>
  listen<string>(`session-output-${id}`, (event) => {
    const binary = atob(event.payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    handler(bytes);
  });

export const onSessionExit = (id: string, handler: () => void): Promise<UnlistenFn> =>
  listen(`session-exit-${id}`, () => handler());

export function encodeInput(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
