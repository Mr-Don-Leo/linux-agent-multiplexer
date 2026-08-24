import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { attachSession, chatSend, detachSession, onChatEvent, onChatHistory } from "../ipc";
import {
  approvalResponseLine,
  codexInterruptLine,
  codexUserLine,
  emptyChatState,
  interruptLine,
  reduceChatLine,
  reduceCodexLine,
  toolSummary,
  userMessageLine,
  type ChatItem,
  type ChatState,
} from "../chat";
import type { Provider } from "../types";
import Markdown from "./Markdown";

interface Props {
  sessionId: string;
  provider: Provider;
  running: boolean;
  /** Fired on live events worth notifying about (approvals, turn completion). */
  onAttention?: (text: string) => void;
}

/** Unsent composer drafts, kept per session for the lifetime of the app so
 * navigating away (projects, settings, other panes) never loses typed text. */
const sessionDrafts = new Map<string, string>();

function ThinkingBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bubble thinking" onClick={() => setOpen(!open)}>
      {open ? <Markdown text={text} /> : `Thinking · ${text.split("\n")[0].slice(0, 80)}…`}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const status = item.result === undefined ? "…" : item.isError ? "✕" : "✓";
  return (
    <div className={"tool-card" + (item.isError ? " error" : "")}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-status">{status}</span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{toolSummary(item.name, item.input)}</span>
      </button>
      {open && (
        <div className="tool-detail">
          <pre>{JSON.stringify(item.input, null, 2).slice(0, 4000)}</pre>
          {item.result !== undefined && <pre className="tool-result">{item.result.slice(0, 4000)}</pre>}
        </div>
      )}
    </div>
  );
}

export default function ChatView({ sessionId, provider, running, onAttention }: Props) {
  const [, forceRender] = useState(0);
  const stateRef = useRef<ChatState>(emptyChatState());
  const [draft, setDraftState] = useState(() => sessionDrafts.get(sessionId) ?? "");
  const setDraft = (value: string) => {
    setDraftState(value);
    if (value) sessionDrafts.set(sessionId, value);
    else sessionDrafts.delete(sessionId);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const onAttentionRef = useRef(onAttention);
  onAttentionRef.current = onAttention;

  useEffect(() => {
    stateRef.current = emptyChatState();
    const rerender = () => forceRender((n) => n + 1);

    const reduce = provider === "codex" ? reduceCodexLine : reduceChatLine;
    const applyLine = (line: string, live: boolean) => {
      const effects = reduce(stateRef.current, line);
      if (live && effects.approvalRequested) {
        onAttentionRef.current?.(
          `Approval needed: ${effects.approvalRequested.toolName}` +
            (effects.approvalRequested.description
              ? ` — ${effects.approvalRequested.description}`
              : ""),
        );
      }
      if (live && effects.turnDone) onAttentionRef.current?.("Finished responding");
    };

    // Cleanup can run before the listen() promises resolve (StrictMode double
    // effects); `cancelled` ensures late-resolving listeners are dropped
    // immediately instead of leaking a second subscription.
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    Promise.all([
      onChatHistory(sessionId, (lines) => {
        stateRef.current = emptyChatState();
        for (const line of lines) applyLine(line, false);
        rerender();
      }),
      onChatEvent(sessionId, (line) => {
        applyLine(line, true);
        rerender();
      }),
    ])
      .then((subs) => {
        if (cancelled) {
          subs.forEach((u) => u());
          return;
        }
        unlisteners.push(...subs);
        return attachSession(sessionId);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      detachSession(sessionId).catch(() => {});
      unlisteners.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, provider]);

  const state = stateRef.current;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const send = () => {
    const text = draft.trim();
    if (!text || !running || state.busy) return;
    state.items.push({ kind: "user", text });
    state.busy = true;
    state.lastResult = undefined;
    setDraft("");
    const line = provider === "codex" ? codexUserLine(text) : userMessageLine(text);
    chatSend(sessionId, line).catch((e) => {
      state.items.push({ kind: "info", text: `Failed to send: ${e}`, error: true });
      state.busy = false;
      forceRender((n) => n + 1);
    });
  };

  const answer = (item: Extract<ChatItem, { kind: "approval" }>, allow: boolean) => {
    item.answered = allow ? "allow" : "deny";
    state.busy = true;
    forceRender((n) => n + 1);
    chatSend(sessionId, approvalResponseLine(item.requestId, allow, item.input)).catch(() => {});
  };

  const interrupt = () => {
    const line = provider === "codex" ? codexInterruptLine() : interruptLine();
    chatSend(sessionId, line).catch(() => {});
    if (provider === "codex") {
      state.busy = false;
      forceRender((n) => n + 1);
    }
  };

  return (
    <div className="chat-view">
      <div className="chat-scroll" ref={scrollRef}>
        {state.items.length === 0 && (
          <div className="chat-info">
            {running ? "Say something to start the conversation." : "Session ended."}
          </div>
        )}
        {state.items.map((item, i) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={i} className="bubble user">
                  <Markdown text={item.text} />
                </div>
              );
            case "assistant":
              return (
                <div key={i} className="bubble assistant">
                  <Markdown text={item.text} />
                </div>
              );
            case "thinking":
              return <ThinkingBubble key={i} text={item.text} />;
            case "tool":
              return <ToolCard key={i} item={item} />;
            case "approval":
              return (
                <div key={i} className={"chat-approval card" + (item.answered ? " answered" : "")}>
                  <div className="approval-q">
                    Allow <strong>{item.toolName}</strong>
                    {item.description ? ` — ${item.description}` : ""}?
                  </div>
                  <pre className="approval-input">
                    {toolSummary(item.toolName, item.input)}
                  </pre>
                  {item.answered === undefined && running ? (
                    <div className="approval-actions">
                      <button className="btn btn-primary" onClick={() => answer(item, true)}>
                        Allow
                      </button>
                      <button className="btn btn-danger" onClick={() => answer(item, false)}>
                        Deny
                      </button>
                    </div>
                  ) : (
                    <span className="pill neutral">
                      {item.answered === "allow"
                        ? "Allowed"
                        : item.answered === "deny"
                          ? "Denied"
                          : "Resolved"}
                    </span>
                  )}
                </div>
              );
            case "info":
              return (
                <div key={i} className={"chat-info" + (item.error ? " error" : "")}>
                  {item.text}
                </div>
              );
          }
        })}
        {state.partial && state.partial.text && (
          <div
            className={
              state.partial.kind === "thinking" ? "bubble thinking streaming" : "bubble assistant"
            }
          >
            <Markdown text={state.partial.text} />
            <span className="stream-cursor" />
          </div>
        )}
        {state.busy && !state.partial?.text && (
          <div className="bubble assistant typing">
            <span className="dot-anim" />
            <span className="dot-anim" />
            <span className="dot-anim" />
          </div>
        )}
        {!state.busy && state.lastResult && <div className="chat-info">{state.lastResult}</div>}
      </div>
      <div className="chat-composer">
        <textarea
          value={draft}
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          placeholder={running ? "Message the agent… (Enter to send)" : "Session ended"}
          disabled={!running}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {state.busy ? (
          <button className="btn btn-danger" title="Interrupt" onClick={interrupt}>
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" onClick={send} disabled={!draft.trim() || !running}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
