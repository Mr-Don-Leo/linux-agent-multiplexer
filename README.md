# AgentMux

**A lightweight Linux multiplexer for AI coding agents.**

Run many concurrent [Claude Code](https://claude.com/claude-code) and [Codex](https://openai.com/codex) sessions across your projects — each with its own agent identity, model, memory, and working directory — and switch between them instantly, like a terminal multiplexer with a modern, native-feeling UI.

Built with [Tauri 2](https://tauri.app) (Rust backend, system webview), so the app stays small and fast.

## Features

- **Onboarding** — pick a username and profile picture, then connect Claude and/or Codex via your existing subscription (CLI sign-in) or an API key. You can also skip and set it up later.
- **Project explorer** — a home screen of project tiles. Create a project with an agent name, optional GitHub repo (cloned for you), optional domain/subdomain and port, a provider (Claude / Codex), a model, and custom instructions.
- **True multiplexing** — every session is a real PTY running the agent CLI. Open as many sessions as you like, across different projects, at the same time; agent questions, permission prompts, and interactive dialogs render exactly as they do in a terminal.
- **Chat mode** — Claude sessions open as a native chat: your messages and the agent's replies as bubbles, its thinking process as collapsible bubbles, tool calls as expandable cards with inputs and results, and permission requests as inline **Allow / Deny** cards driven by Claude Code's structured stream-json protocol (exact, not parsed from terminal output). A typing indicator, Stop/interrupt button, and per-turn duration/cost round it out.
- **Terminal mode** — every project can also open classic PTY sessions (the default for Codex); numbered menus in terminal output are additionally surfaced as heuristic approval cards above the pane.
- **Split view** — up to four sessions visible side by side in a grid; click a session's ⊞ to add it to the split.
- **Session persistence** — sessions open when you quit are offered for restore on the next launch, resuming the agent conversation via `claude --continue` / `codex resume --last`.
- **Agent memory** — a per-session Memory panel to view and edit the project memory file (`CLAUDE.md` / `AGENTS.md`) and your global memory, plus one-click context compaction (`/compact`).
- **Theme gallery** — Modern (HIG-inspired, light/dark/system), Cyberpunk (neon grid), and Retro XP (Luna nostalgia). Skins are pure CSS tokens, so adding more is easy.
- **Notifications** — a desktop notification fires when a background session asks a question or ends.
- **Usage overview** — sessions and time per provider and per project for the last 7 days.

## Install

Grab the latest `.deb`, `.rpm`, or `.AppImage` from the [Releases](https://github.com/Mr-Don-Leo/linux-agent-multiplexer/releases) page.

```bash
# Debian / Ubuntu
sudo dpkg -i AgentMux_*.deb

# Fedora / RHEL
sudo rpm -i AgentMux-*.rpm

# Any distro
chmod +x AgentMux_*.AppImage && ./AgentMux_*.AppImage
```

You'll also need at least one agent CLI installed:

```bash
npm install -g @anthropic-ai/claude-code   # Claude Code
npm install -g @openai/codex               # Codex
```

## Build from source

Prerequisites: [Rust](https://rustup.rs), Node.js ≥ 20, and the Tauri Linux dependencies:

```bash
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev file
```

```bash
git clone https://github.com/Mr-Don-Leo/linux-agent-multiplexer.git
cd linux-agent-multiplexer
npm install
npm run tauri dev     # development
npm run tauri build   # produces .deb / .rpm / .AppImage in src-tauri/target/release/bundle/
```

## How it works

- The Rust backend spawns each agent CLI inside a PTY ([portable-pty](https://crates.io/crates/portable-pty)) with the project directory as its working directory, streams output to the UI over Tauri events, and keeps a rolling scrollback per session so switching views never loses output.
- Project instructions are written into the project's `CLAUDE.md` / `AGENTS.md`, which the agent CLIs load natively as memory.
- API keys are stored locally in `~/.config/agentmux/config.json` and injected into sessions as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Subscription auth just uses the CLI's own login.

## Roadmap

- [ ] User-defined themes
- [ ] Drag-to-rearrange split panes
- [ ] Cost estimates in the usage overview
- [ ] Flatpak / AUR packaging

## A note on Apple design resources

The UI follows Apple's Human Interface Guidelines, and the font stack prefers `SF Pro Text` / `SF Mono` when installed locally. Apple's design resources (SF fonts, SF Symbols) are **not** bundled because their license doesn't permit redistribution; the app falls back to your system fonts.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
