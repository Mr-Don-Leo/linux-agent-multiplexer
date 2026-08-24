/**
 * Heuristic detection of interactive menus in agent CLI output (trust dialogs,
 * permission prompts, plan approvals). Works on ANSI-stripped text; when a
 * numbered option block is visible at the end of the screen, we surface it as
 * an approval card. Best-effort by design — the terminal underneath always
 * remains the source of truth.
 */

export interface DetectedPrompt {
  question: string;
  options: { key: string; label: string }[];
}

// CSI / OSC / charset escape sequences.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const OPTION_RE = /^[\s>❯▶]*(\d{1,2})\.\s+(.+?)\s*$/;

export function detectPrompt(rawTail: string): DetectedPrompt | null {
  const plain = stripAnsi(rawTail).replace(/\r/g, "");
  const lines = plain.split("\n").map((l) => l.trimEnd());

  // Find the last contiguous block of numbered options.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_RE.test(lines[i])) {
      end = i;
      break;
    }
    // Allow a couple of trailing hint lines ("Enter to confirm · Esc to cancel").
    if (end === -1 && i < lines.length - 6 && lines[i].trim() !== "") break;
  }
  if (end === -1) return null;

  let start = end;
  while (start > 0 && OPTION_RE.test(lines[start - 1])) start--;

  const options = lines
    .slice(start, end + 1)
    .map((l) => OPTION_RE.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ key: m[1], label: m[2].replace(/\s{2,}.*$/, "").slice(0, 80) }));

  // Menus are numbered 1..n; anything else is probably a list in normal output.
  if (options.length < 2 || options.length > 6 || options[0].key !== "1") return null;
  if (options.some((o, i) => Number(o.key) !== i + 1)) return null;

  // The question is the nearest non-empty line above the block.
  let question = "";
  for (let i = start - 1; i >= 0 && i >= start - 8; i--) {
    const candidate = lines[i].trim().replace(/^[│┃|]\s*/, "");
    if (candidate.length > 3 && !/^[-─═┌└╭╰+]+$/.test(candidate)) {
      question = candidate.slice(0, 160);
      break;
    }
  }
  return { question, options };
}
