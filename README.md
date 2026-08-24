# AgentMux

**A lightweight Linux multiplexer for AI coding agents.**

Run many concurrent [Claude Code](https://claude.com/claude-code) and [Codex](https://openai.com/codex) sessions across your projects — each with its own agent identity, model, memory, and working directory — and switch between them instantly, like a terminal multiplexer with a modern, native-feeling UI.

Built with [Tauri 2](https://tauri.app) (Rust backend, system webview), so the app stays small and fast.

## Features

- **Onboarding** — pick a username and profile picture, then connect Claude and/or Codex via your existing subscription (CLI sign-in) or an API key. You can also skip and set it up later.
- **Project explorer** — a home screen of project tiles. Create a project with an agent name, optional GitHub repo (cloned for you), optional domain/subdomain and port, a provider (Claude / Codex), a model, and custom instructions.
- **True multiplexing** — every session is a real PTY running the agent CLI. Open as many sessions as you like, across different projects, at the same time; agent questions, permission prompts, and interactive dialogs render exactly as they do in a terminal.
- **Agent memory** — a per-session Memory panel to view and edit the project memory file (`CLAUDE.md` / `AGENTS.md`) and your global memory, plus one-click context compaction (`/compact`).
- **Dark & light mode** — follows your system by default, toggleable in-app. More themes are planned.

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

- [ ] More themes (including a cyberpunk one)
- [ ] Split view: multiple terminals visible side by side
- [ ] Structured approval UI (parse agent permission prompts into native dialogs)
- [ ] Session persistence across app restarts
- [ ] Usage/cost overview per provider
- [ ] Flatpak / AUR packaging

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
