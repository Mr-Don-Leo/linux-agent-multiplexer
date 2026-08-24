import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppConfig, NewProject, Project, SessionInfo, Theme } from "./types";
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

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const systemDark = useSystemDark();
  const dark = config ? (config.theme === "system" ? systemDark : config.theme === "dark") : systemDark;

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  useEffect(() => {
    Promise.all([ipc.getConfig(), ipc.listProjects()]).then(([cfg, projs]) => {
      setConfig(cfg);
      setProjects(projs);
      setScreen(cfg.onboarded ? "home" : "onboarding");
    });
  }, []);

  const setTheme = useCallback(
    (theme: Theme) => {
      if (!config) return;
      const next = { ...config, theme };
      setConfig(next);
      ipc.saveConfig(next).catch(() => {});
    },
    [config],
  );

  const createProject = useCallback(async (p: NewProject) => {
    const project = await ipc.createProject(p);
    setProjects((prev) => [...prev, project]);
  }, []);

  const deleteProject = useCallback((id: string) => {
    ipc.deleteProject(id).catch(() => {});
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const openSession = useCallback(async (project: Project) => {
    const session = await ipc.createSession(project.id);
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
    setScreen("workspace");
  }, []);

  const closeSession = useCallback(
    (id: string) => {
      ipc.killSession(id).catch(() => {});
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (activeSessionId === id) setActiveSessionId(next[next.length - 1]?.id ?? null);
        return next;
      });
    },
    [activeSessionId],
  );

  const markExited = useCallback((id: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, running: false } : s)));
  }, []);

  const activeCount = useMemo(() => sessions.filter((s) => s.running).length, [sessions]);

  if (screen === "loading" || !config) return null;

  if (screen === "onboarding") {
    return (
      <Onboarding
        config={config}
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
        dark={dark}
        projects={projects}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        onNewSession={openSession}
        onCloseSession={closeSession}
        onSessionExit={markExited}
        onBack={() => setScreen("home")}
      />
    );
  }

  return (
    <Home
      config={config}
      projects={projects}
      onCreate={createProject}
      onDelete={deleteProject}
      onOpen={openSession}
      onTheme={setTheme}
      activeSessionCount={activeCount}
      onGoWorkspace={() => setScreen("workspace")}
    />
  );
}
