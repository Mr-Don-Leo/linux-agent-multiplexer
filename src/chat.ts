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
    case "assistant": {
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
