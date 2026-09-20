# Secure ChatGPT Web fallback

## Purpose

This fork provides a locally built ChatGPT Web fallback for Codex when Codex usage is unavailable. It preserves native Codex Authorization for native models and uses ChatGPT Web limits only for the explicit ChatGPT Web model routes.

## Security properties

- Automatic browser interaction and Zero Risk manual interaction are both supported.
- Automatic mode uses an ephemeral loopback CDP endpoint and only the launcher's isolated Secure browser partition and owned surface targets.
- Launcher liveness uses the existing authenticated loopback control channel.
- OpenAI-compatible provider routes require an unguessable local capability in the path.
- Provider routes reject browser-origin metadata before parsing a body or creating an adapter.
- Encoded request bodies are read incrementally with a hard size cap.
- Zstandard decoding uses a bounded output allocation.
- Native request bodies are read once and forwarded without changing the incoming Codex Authorization.
- Remote launcher updates are disabled by default.
- The fork has a separate product name, application ID, installer GUID, profile directory, browser partition, and release artifact name.
- Removal offers an explicit choice between disconnecting the Codex route and erasing the owned ChatGPT browser session.

## User workflow

1. Build the launcher locally with the repository-pinned Bun 1.4.0 toolchain.
2. Install and open Codex Web GPT Secure.
3. Complete Full MCP setup in Automatic mode. Zero Risk remains available as a manual fallback.
4. Restart Codex once after route installation.
5. Choose a ChatGPT Web model only when the fallback is wanted.
6. Let the launcher submit and collect the ChatGPT turn through its owned CDP browser. In Zero Risk mode, copy, send, and confirm manually instead.

Native Codex models continue through the ordinary Codex backend. The bridge does not replace their Authorization with the local launcher capability.

## Verification

- Root TypeScript typecheck
- Launcher TypeScript typecheck
- Focused route, request-body, launcher-control, updater, removal, and packaging tests
- Full repository tests, with Windows symlink-only cases recorded separately when developer mode is unavailable
- Runtime bundle build
- Launcher renderer build
- Windows installer packaging
- Microsoft Defender scan of the produced installer
