/**
 * Claude Code stream-json protocol → chat item model.
 *
 * Each stdout line of a chat session is one JSON event. The reducer folds
 * events into renderable items (bubbles, tool cards, approval requests).
 */

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      toolUseId: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
    }
  | {
      kind: "approval";
      requestId: string;
      toolName: string;
      description?: string;
      input: unknown;
      /** Undefined while actionable; set once answered or superseded. */
      answered?: "allow" | "deny" | "stale";
      toolUseId?: string;
    }
  | { kind: "info"; text: string; error?: boolean };

export interface ChatState {
  items: ChatItem[];
  /** Agent is working (between a user turn / approval answer and the result). */
  busy: boolean;
  model?: string;
  lastResult?: string;
  /** In-flight streamed content, rendered as a live-updating bubble. */
  partial?: { kind: "text" | "thinking"; text: string };
}

export function emptyChatState(): ChatState {
  return { items: [], busy: false };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

/** Mark any still-actionable approval as superseded (agent moved on). */
function staleApprovals(items: ChatItem[]) {
  for (const item of items) {
    if (item.kind === "approval" && item.answered === undefined) item.answered = "stale";
  }
}

export interface ReduceEffects {
  approvalRequested?: { toolName: string; description?: string };
  turnDone?: boolean;
}

/** Applies one protocol line to the state (mutating). Returns UI side-effects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reduceChatLine(state: ChatState, line: string): ReduceEffects {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  const effects: ReduceEffects = {};

  switch (event.type) {
    case "system": {
      if (event.subtype === "init" && !state.model) {
        state.model = event.model;
        state.items.push({ kind: "info", text: `Session started · ${event.model}` });
      }
      break;
    }
    case "stream_event": {
      const ev = event.event;
      if (!ev) break;
      if (ev.type === "content_block_start") {
        const blockType = ev.content_block?.type;
        state.partial =
          blockType === "thinking"
            ? { kind: "thinking", text: "" }
            : blockType === "text"
              ? { kind: "text", text: "" }
              : undefined;
      } else if (ev.type === "content_block_delta") {
        const delta = ev.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          if (!state.partial || state.partial.kind !== "text")
            state.partial = { kind: "text", text: "" };
          state.partial.text += delta.text;
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          if (!state.partial || state.partial.kind !== "thinking")
            state.partial = { kind: "thinking", text: "" };
          state.partial.text += delta.thinking;
        }
      }
      // content_block_stop: keep the partial visible until the completed
      // assistant event replaces it.
      break;
    }
    case "assistant": {
      state.partial = undefined;
      staleApprovals(state.items);
      const blocks = event.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) {
          state.items.push({ kind: "assistant", text: block.text });
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          state.items.push({ kind: "thinking", text: block.thinking });
        } else if (block.type === "tool_use") {
          state.items.push({
            kind: "tool",
            toolUseId: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }
      break;
    }
    case "user": {
      const blocks = event.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            // User messages are echoed back (--replay-user-messages). The
            // composer already appended this text locally on send, so skip the
            // echo when it matches the most recent user bubble.
            const lastUser = [...state.items]
              .reverse()
              .find((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user");
            if (lastUser?.text !== block.text) {
              state.items.push({ kind: "user", text: block.text });
            }
          } else if (block.type === "tool_result") {
            const tool = state.items.find(
              (i): i is Extract<ChatItem, { kind: "tool" }> =>
                i.kind === "tool" && i.toolUseId === block.tool_use_id,
            );
            if (tool) {
              tool.result = contentToText(block.content).slice(0, 20000);
              tool.isError = block.is_error === true;
            }
            const approval = state.items.find(
              (i): i is Extract<ChatItem, { kind: "approval" }> =>
                i.kind === "approval" && i.toolUseId === block.tool_use_id,
            );
            if (approval && approval.answered === undefined) approval.answered = "allow";
          }
        }
      }
      break;
    }
    case "control_request": {
      if (event.request?.subtype === "can_use_tool") {
        state.items.push({
          kind: "approval",
          requestId: event.request_id,
          toolName: event.request.display_name || event.request.tool_name,
          description: event.request.description,
          input: event.request.input,
          toolUseId: event.request.tool_use_id,
        });
        state.busy = false;
        effects.approvalRequested = {
          toolName: event.request.display_name || event.request.tool_name,
          description: event.request.description,
        };
      }
      break;
    }
    case "result": {
      staleApprovals(state.items);
      state.busy = false;
      state.partial = undefined;
      const secs = event.duration_ms ? (event.duration_ms / 1000).toFixed(1) + "s" : "";
      const cost =
        typeof event.total_cost_usd === "number" && event.total_cost_usd > 0
          ? ` · $${event.total_cost_usd.toFixed(4)}`
          : "";
      state.lastResult = `Done${secs ? ` · ${secs}` : ""}${cost}`;
      effects.turnDone = true;
      if (event.is_error && typeof event.result === "string") {
        state.items.push({ kind: "info", text: event.result, error: true });
      }
      break;
    }
    case "stderr": {
      if (typeof event.text === "string" && !/^\s*$/.test(event.text)) {
        state.items.push({ kind: "info", text: event.text, error: true });
      }
      break;
    }
    default:
      break;
  }
  return effects;
}

function upsertTool(
  state: ChatState,
  id: string,
  name: string,
  input: unknown,
): Extract<ChatItem, { kind: "tool" }> {
  const existing = state.items.find(
    (i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool" && i.toolUseId === id,
  );
  if (existing) return existing;
  const item: Extract<ChatItem, { kind: "tool" }> = { kind: "tool", toolUseId: id, name, input };
  state.items.push(item);
  return item;
}

function pushUserDeduped(state: ChatState, text: string) {
  const lastUser = [...state.items]
    .reverse()
    .find((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user");
  if (lastUser?.text !== text) state.items.push({ kind: "user", text });
}

/**
 * Codex `exec --json` events (thread.started / turn.* / item.*) → chat items.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reduceCodexLine(state: ChatState, line: string): ReduceEffects {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  const effects: ReduceEffects = {};

  switch (event.type) {
    case "thread.started": {
      if (!state.model) {
        state.model = "codex";
        state.items.push({ kind: "info", text: "Session started · Codex" });
      }
      break;
    }
    case "turn.started": {
      state.busy = true;
      break;
    }
    case "user_echo": {
      if (typeof event.text === "string") pushUserDeduped(state, event.text);
      break;
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = event.item;
      if (!item) break;
      const completed = event.type === "item.completed";
      switch (item.type) {
        case "agent_message": {
          if (completed && item.text?.trim()) {
            state.items.push({ kind: "assistant", text: item.text });
          }
          break;
        }
        case "reasoning": {
          const text = item.text ?? item.summary;
          if (completed && typeof text === "string" && text.trim()) {
            state.items.push({ kind: "thinking", text });
          }
          break;
        }
        case "command_execution": {
          const tool = upsertTool(state, item.id, "Shell", { command: item.command });
          if (completed) {
            tool.result = String(item.aggregated_output ?? "").slice(0, 20000);
            tool.isError = item.status === "failed" || (item.exit_code ?? 0) !== 0;
          }
          break;
        }
        case "file_change": {
          const tool = upsertTool(state, item.id, "Edit", { changes: item.changes });
          if (completed) {
            tool.result = JSON.stringify(item.changes ?? item, null, 2).slice(0, 4000);
            tool.isError = item.status === "failed";
          }
          break;
        }
        case "web_search": {
          const tool = upsertTool(state, item.id, "WebSearch", { query: item.query });
          if (completed) tool.result = "done";
          break;
        }
        case "mcp_tool_call": {
          const tool = upsertTool(state, item.id, item.tool ?? "MCP", item.arguments ?? {});
          if (completed) {
            tool.result = JSON.stringify(item.result ?? {}, null, 2).slice(0, 4000);
            tool.isError = item.status === "failed";
          }
          break;
        }
        case "error": {
          if (typeof item.message === "string") {
            state.items.push({ kind: "info", text: item.message, error: true });
          }
          break;
        }
        default:
          break;
      }
      break;
    }
    case "turn.completed": {
      state.busy = false;
      const usage = event.usage;
      state.lastResult = usage
        ? `Done · ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out tokens`
        : "Done";
      effects.turnDone = true;
      break;
    }
    case "turn.failed": {
      state.busy = false;
      const message = event.error?.message ?? "Turn failed";
      state.items.push({ kind: "info", text: String(message), error: true });
      effects.turnDone = true;
      break;
    }
    case "stderr": {
      if (typeof event.text === "string" && !/^\s*$/.test(event.text)) {
        state.items.push({ kind: "info", text: event.text, error: true });
      }
      break;
    }
    default:
      break;
  }
  return effects;
}

export function codexUserLine(text: string): string {
  return JSON.stringify({ type: "user_text", text });
}

export function codexInterruptLine(): string {
  return JSON.stringify({ type: "interrupt" });
}

let requestCounter = 0;

export function userMessageLine(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

export function approvalResponseLine(
  requestId: string,
  allow: boolean,
  input: unknown,
): string {
  const response = allow
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "The user declined this action." };
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

export function interruptLine(): string {
  return JSON.stringify({
    type: "control_request",
    request_id: `ui-${++requestCounter}`,
    request: { subtype: "interrupt" },
  });
}

/** One-line human summary of a tool input for card headers. */
export function toolSummary(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const i = input as Record<string, unknown>;
    const candidate =
      i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
    if (typeof candidate === "string") return candidate.slice(0, 80);
  }
  try {
    const json = JSON.stringify(input);
    return json === "{}" ? name : json.slice(0, 80);
  } catch {
    return name;
  }
}
