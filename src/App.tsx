import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type {
  AppConfig,
  NewProject,
  Project,
  RestorableSession,
  SessionInfo,
  SessionKind,
  Skin,
  Theme,
} from "./types";
import type { DetectedPrompt } from "./prompt";
import * as ipc from "./ipc";
import Onboarding from "./screens/Onboarding";
import Home from "./screens/Home";
import Workspace from "./screens/Workspace";

type Screen = "loading" | "onboarding" | "home" | "workspace";

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const cb = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, []);
  return dark;
}

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // Notifications are best-effort.
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [panes, setPanes] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, DetectedPrompt>>({});
  const [restorable, setRestorable] = useState<RestorableSession[]>([]);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const configRef = useRef(config);
  configRef.current = config;
  const exitUnlisteners = useRef<Record<string, UnlistenFn>>({});

  const systemDark = useSystemDark();
  const skin: Skin = config?.skin ?? "apple";
  const dark =
    skin === "cyberpunk"
      ? true
      : skin === "xp"
        ? false
        : config
          ? config.theme === "system"
            ? systemDark
            : config.theme === "dark"
          : systemDark;

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.skin = skin;
  }, [dark, skin]);

  const booted = useRef(false);
  useEffect(() => {
    // restorableSessions() is consume-on-read; guard against StrictMode's
    // double effect invocation in dev.
    if (booted.current) return;
    booted.current = true;
    Promise.all([ipc.getConfig(), ipc.listProjects(), ipc.restorableSessions()]).then(
      ([cfg, projs, restore]) => {
        setConfig(cfg);
        setProjects(projs);
        setRestorable(restore.filter((r) => projs.some((p) => p.id === r.projectId)));
        setScreen(cfg.onboarded ? "home" : "onboarding");
      },
    );
  }, []);

  const patchConfig = useCallback((patch: Partial<AppConfig>) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      ipc.saveConfig(next).catch(() => {});
      return next;
    });
  }, []);

  const setTheme = useCallback((theme: Theme) => patchConfig({ theme }), [patchConfig]);
  const setSkin = useCallback((skin: Skin) => patchConfig({ skin }), [patchConfig]);

  const createProject = useCallback(async (p: NewProject) => {
    const project = await ipc.createProject(p);
    setProjects((prev) => [...prev, project]);
  }, []);

  const updateProject = useCallback(async (id: string, p: NewProject) => {
    const updated = await ipc.updateProject(id, p);
    setProjects((prev) => prev.map((proj) => (proj.id === id ? updated : proj)));
  }, []);

  const deleteProject = useCallback((id: string) => {
    ipc.deleteProject(id).catch(() => {});
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const markExited = useCallback((id: string) => {
    exitUnlisteners.current[id]?.();
    delete exitUnlisteners.current[id];
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, running: false } : s)));
    const session = sessionsRef.current.find((s) => s.id === id);
    if (configRef.current?.notifications && session && !document.hasFocus()) {
      notify("Session ended", session.title);
    }
  }, []);

  /** Track a new session: add to state and watch for its exit event, so even
   * sessions hidden from view update their running state. */
  const trackSession = useCallback(
    (session: SessionInfo) => {
      setSessions((prev) => [...prev, session]);
      listen(`session-exit-${session.id}`, () => markExited(session.id)).then((unlisten) => {
        exitUnlisteners.current[session.id] = unlisten;
      });
    },
    [markExited],
  );

  const openSession = useCallback(
    async (project: Project, kind?: SessionKind, resume = false) => {
      const sessionKind: SessionKind = kind ?? "chat";
      const session = await ipc.createSession(project.id, resume, sessionKind);
      trackSession(session);
      setPanes((prev) =>
        prev.length > 0 && prev.length < 4 ? [...prev, session.id] : [session.id],
      );
      setFocusedId(session.id);
      setScreen("workspace");
      return session;
    },
    [trackSession],
  );

  /** Home-screen project click: focus an existing running session for the
   * project if there is one; only create a new session when there is none. */
  const openProject = useCallback(
    async (project: Project) => {
      const existing = sessionsRef.current.filter(
        (s) => s.projectId === project.id && s.running,
      );
      if (existing.length > 0) {
        const target =
          existing.find((s) => panesRef.current.includes(s.id)) ?? existing[0];
        if (!panesRef.current.includes(target.id)) setPanes([target.id]);
        setFocusedId(target.id);
        setScreen("workspace");
        return;
      }
      await openSession(project);
    },
    [openSession],
  );

  const restoreAll = useCallback(async () => {
    const entries = [...restorable];
    setRestorable([]);
    const restored: string[] = [];
    for (const entry of entries) {
      const project = projects.find((p) => p.id === entry.projectId);
      if (!project) continue;
      try {
        const session = await ipc.createSession(project.id, true, entry.kind);
        trackSession(session);
        restored.push(session.id);
      } catch {
        // CLI missing or spawn failure; skip this one.
      }
    }
    if (restored.length > 0) {
      setPanes(restored.slice(0, 2));
      setFocusedId(restored[0]);
      setScreen("workspace");
    }
  }, [restorable, projects, trackSession]);

  const closeSession = useCallback((id: string) => {
    exitUnlisteners.current[id]?.();
    delete exitUnlisteners.current[id];
    ipc.killSession(id).catch(() => {});
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setPanes((prev) => prev.filter((p) => p !== id));
    setFocusedId((prev) => (prev === id ? null : prev));
    setPrompts((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  /** Notification-worthy moments from chat sessions (approvals, turn done). */
  const handleAttention = useCallback((sessionId: string, text: string) => {
    if (!configRef.current?.notifications || document.hasFocus()) return;
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    notify(session?.title ?? "Agent", text);
  }, []);

  const handlePrompt = useCallback((sessionId: string, prompt: DetectedPrompt | null) => {
    setPrompts((prev) => {
      if (!prompt) {
        if (!(sessionId in prev)) return prev;
        const { [sessionId]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [sessionId]: prompt };
    });
    if (prompt && configRef.current?.notifications && !document.hasFocus()) {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      notify(session?.title ?? "Agent", prompt.question || "The agent needs your input");
    }
  }, []);

  const setPaneState = useCallback((nextPanes: string[], nextFocused: string | null) => {
    setPanes(nextPanes);
    setFocusedId(nextFocused);
  }, []);

  const activeCount = useMemo(() => sessions.filter((s) => s.running).length, [sessions]);

  if (screen === "loading" || !config) return null;

  if (screen === "onboarding") {
    return (
      <Onboarding
        config={config}
        skin={skin}
        dark={dark}
        onDone={(cfg) => {
          setConfig(cfg);
          setScreen("home");
        }}
      />
    );
  }

  if (screen === "workspace") {
    return (
      <Workspace
        skin={skin}
        dark={dark}
        projects={projects}
        sessions={sessions}
        panes={panes}
        focusedId={focusedId}
        onPanesChange={setPaneState}
        onNewSession={openSession}
        onCloseSession={closeSession}
        onSessionExit={markExited}
        onPrompt={handlePrompt}
        onAttention={handleAttention}
        prompts={prompts}
        onBack={() => setScreen("home")}
      />
    );
  }

  return (
    <Home
      config={config}
      projects={projects}
      onCreate={createProject}
      onUpdate={updateProject}
      onDelete={deleteProject}
      onOpen={openProject}
      onTheme={setTheme}
      onSkin={setSkin}
      restorableCount={restorable.length}
      onRestore={restoreAll}
      onDismissRestore={() => setRestorable([])}
      activeSessionCount={activeCount}
      onGoWorkspace={() => setScreen("workspace")}
    />
  );
}
