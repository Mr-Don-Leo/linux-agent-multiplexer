import { useEffect, useRef } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  attachSession,
  detachSession,
  encodeInput,
  onSessionExit,
  onSessionOutput,
  resizeSession,
  writeSession,
} from "../ipc";
import type { Skin } from "../types";
import { detectPrompt, type DetectedPrompt } from "../prompt";

const TERMINAL_THEMES: Record<string, ITheme> = {
  light: {
    background: "#ffffff",
    foreground: "#1d1d1f",
    cursor: "#007aff",
    selectionBackground: "rgba(0, 122, 255, 0.25)",
  },
  dark: {
    background: "#131316",
    foreground: "#f5f5f7",
    cursor: "#0a84ff",
    selectionBackground: "rgba(10, 132, 255, 0.35)",
  },
  cyberpunk: {
    background: "#0b0714",
    foreground: "#d6f4ff",
    cursor: "#00f0ff",
    cursorAccent: "#0b0714",
    selectionBackground: "rgba(255, 46, 196, 0.35)",
    magenta: "#ff2ec4",
    cyan: "#00f0ff",
    green: "#3dffa2",
  },
  xp: {
    background: "#ffffff",
    foreground: "#1a1a1a",
    cursor: "#0a53be",
    selectionBackground: "rgba(49, 106, 197, 0.35)",
  },
};

export function terminalTheme(skin: Skin, dark: boolean): ITheme {
  if (skin === "cyberpunk") return TERMINAL_THEMES.cyberpunk;
  if (skin === "xp") return TERMINAL_THEMES.xp;
  return dark ? TERMINAL_THEMES.dark : TERMINAL_THEMES.light;
}

const PROMPT_TAIL_BYTES = 4096;
const PROMPT_DEBOUNCE_MS = 350;

interface Props {
  sessionId: string;
  skin: Skin;
  dark: boolean;
  onExit?: () => void;
  /** Called when a numbered menu (approval / question) appears or disappears. */
  onPrompt?: (prompt: DetectedPrompt | null) => void;
}

/**
 * One xterm.js instance bound to a backend PTY session. On mount it subscribes,
 * then attaches (the backend replays scrollback); on unmount it detaches so
 * output keeps accumulating server-side.
 */
export default function Terminal({ sessionId, skin, dark, onExit, onPrompt }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const onPromptRef = useRef(onPrompt);
  const onExitRef = useRef(onExit);
  onPromptRef.current = onPrompt;
  onExitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: '"SF Mono", ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 8000,
      theme: terminalTheme(skin, dark),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();
    termRef.current = term;

    let tail = "";
    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPromptKey = "";
    const scanForPrompt = () => {
      const prompt = detectPrompt(tail);
      const key = prompt ? prompt.question + prompt.options.map((o) => o.label).join("|") : "";
      if (key !== lastPromptKey) {
        lastPromptKey = key;
        onPromptRef.current?.(prompt);
      }
    };

    const decoder = new TextDecoder();
    // Cleanup can run before the listen() promises resolve (StrictMode double
    // effects); `cancelled` drops late-resolving listeners instead of leaking
    // a duplicate subscription.
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const track = (u: UnlistenFn) => {
      if (cancelled) u();
      else unlisteners.push(u);
    };
    onSessionExit(sessionId, () => {
      term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
      onExitRef.current?.();
    }).then(track);
    // Subscribe first, then attach: the backend only streams live output after
    // attach, which also replays the session's scrollback.
    onSessionOutput(sessionId, (bytes) => {
      term.write(bytes);
      tail = (tail + decoder.decode(bytes, { stream: true })).slice(-PROMPT_TAIL_BYTES);
      clearTimeout(promptTimer);
      promptTimer = setTimeout(scanForPrompt, PROMPT_DEBOUNCE_MS);
    })
      .then((u) => {
        track(u);
        if (!cancelled) return attachSession(sessionId);
      })
      .catch(() => {});

    const inputSub = term.onData((data) => {
      writeSession(sessionId, encodeInput(data)).catch(() => {});
    });

    const doResize = () => {
      fit.fit();
      resizeSession(sessionId, term.cols, term.rows).catch(() => {});
    };
    doResize();
    const observer = new ResizeObserver(() => doResize());
    observer.observe(host);

    term.focus();

    return () => {
      cancelled = true;
      detachSession(sessionId).catch(() => {});
      clearTimeout(promptTimer);
      onPromptRef.current?.(null);
      observer.disconnect();
      inputSub.dispose();
      unlisteners.forEach((u) => u());
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(skin, dark);
  }, [skin, dark]);

  return <div className="terminal-host" ref={hostRef} />;
}
