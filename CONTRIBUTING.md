# Contributing to AgentMux

Thanks for your interest! AgentMux is MIT-licensed and contributions of all kinds are welcome — bug reports, feature ideas, docs, and code.

## Development setup

1. Install [Rust](https://rustup.rs), Node.js ≥ 20, and the Tauri Linux deps:
   ```bash
   sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev file
   ```
2. `npm install`
3. `npm run tauri dev`

## Project layout

```
src/          React + TypeScript frontend (screens, components, IPC wrappers)
src-tauri/    Rust backend
  src/session.rs   PTY session manager (the multiplexer core)
  src/projects.rs  Project store + creation (git clone, memory seeding)
  src/config.rs    App config (user, providers, theme)
```

## Guidelines

- Keep the app lightweight: think twice before adding dependencies.
- Frontend must pass `npm run build` (tsc strict + vite).
- Rust must pass `cargo check` and ideally `cargo clippy` with no new warnings.
- Use conventional commits (`feat:`, `fix:`, `docs:`, …) in imperative mood.
- Match the existing UI design language (Apple-like, token-driven CSS in `src/styles.css`; both themes must look right).

## Releases

Pushing a tag `v*` triggers the release workflow, which builds `.deb`, `.rpm`, and `.AppImage` bundles and drafts a GitHub Release.
