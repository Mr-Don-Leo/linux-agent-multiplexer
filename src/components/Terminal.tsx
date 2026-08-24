import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
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

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1d1d1f",
  cursor: "#007aff",
  selectionBackground: "rgba(0, 122, 255, 0.25)",
};

const DARK_THEME = {
  background: "#131316",
  foreground: "#f5f5f7",
  cursor: "#0a84ff",
  selectionBackground: "rgba(10, 132, 255, 0.35)",
};

interface Props {
  sessionId: string;
  dark: boolean;
  onExit?: () => void;
}

/**
 * One xterm.js instance bound to a backend PTY session. The terminal instance
 * lives for as long as the component is mounted; scrollback for background
 * sessions is preserved by keeping components mounted and toggling visibility.
 */
export default function Terminal({ sessionId, dark, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'var(--font-mono), "SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 8000,
      theme: dark ? DARK_THEME : LIGHT_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();
    termRef.current = term;

    const unlisteners: UnlistenFn[] = [];
    const exitSub = onSessionExit(sessionId, () => {
      term.write("\r\n\x1b[2m[session ended]\x1b[0m\r\n");
      onExit?.();
    });
    // Subscribe first, then attach: the backend only streams live output after
    // attach, which also replays the session's scrollback.
    onSessionOutput(sessionId, (bytes) => term.write(bytes))
      .then((u) => {
        unlisteners.push(u);
        return attachSession(sessionId);
      })
      .catch(() => {});
    exitSub.then((u) => unlisteners.push(u));

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
      detachSession(sessionId).catch(() => {});
      observer.disconnect();
      inputSub.dispose();
      unlisteners.forEach((u) => u());
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    termRef.current?.options && (termRef.current.options.theme = dark ? DARK_THEME : LIGHT_THEME);
  }, [dark]);

  return <div className="terminal-host" ref={hostRef} />;
}
