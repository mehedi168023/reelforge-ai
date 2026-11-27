# ReelForge Web

A React app that turns a brief and your files into a finished MP4, entirely in the browser. There is no server: you bring your own Anthropic key, and a voice provider (Cartesia or ElevenLabs) is optional for voiceover and speech timing.

## Desktop app (Windows)

The same app as a native window, with three things a browser can't do:

- **Any AI on your PC.** Pick Claude Code, Codex, Antigravity (`agy`) or Gemini CLI in Settings. ReelForge finds the ones installed, runs them headless in the project folder, and gives them its video tools (snapshot, render, video_frames, transcribe, voice and the skills) over MCP. They use your own sign-in or plan, so no API key is needed. The built-in Claude API engine still works too.
- **Any footage.** FFmpeg converts HEVC/H.265, 10-bit, HDR and odd containers to H.264 on import, using the GPU encoder (NVENC, Quick Sync or AMF) when there is one. Big clips stream from disk instead of loading into memory, and their sound is pulled out once by FFmpeg.
- **Real files.** Projects and renders are saved in `Videos\ReelForge\<project>`. Use **Folder**, **Show in folder** and **Save MP4 as**.

```bash
npm install
npm run desktop:dev   # live-reloading desktop app
npm run desktop       # build the page, then open the desktop app
npm run engine        # build the native C++ engine (native/build.mjs)
npm run dist:win      # engine + installer and portable .exe in release/
```

The native engine builds with clang (llvm-mingw), CMake and Ninja against an FFmpeg shared build. `native/build.mjs` finds them in `%LOCALAPPDATA%\ReelForgeDev` (unzipped there) and CMake/Ninja from `pip install cmake ninja`; set `RF_FFMPEG_ROOT` to use another FFmpeg.

How it fits together:

| Part | File | What it does |
| --- | --- | --- |
| Main process | `electron/main.cjs` | Window, `app://` protocol, project files on disk, IPC |
| AI engines | `electron/engines.cjs` | Finds the CLIs, builds each one's headless command, reads its event stream |
| MCP | `electron/mcp-server.cjs`, `electron/mcp-bridge.cjs` | Localhost MCP endpoint; the bridge is the stdio server each CLI starts |
| Media | `electron/media.cjs` | FFprobe check, GPU H.264 conversion, sound extraction |
| Page side | `src/lib/desktop.ts` | The preload API, used by storage, the agent and the screens |
| Native engine | `native/engine` (C++20, CMake) | `rfengine.exe`: joins clips on tracks (trim, split, layers, picture-in-picture, sound) with D3D11VA GPU decode and NVENC/Quick Sync/AMF encode; probe; waveforms |
| Editor | `src/screens/Editor.tsx`, `src/lib/preview.ts`, `src/lib/pageEdit.ts` | Live player, multi-track timeline, caption editing |

Antigravity keeps one global MCP list, so the first Antigravity job adds a `reelforge` entry to it (`agy mcp list` shows it). It points at the running app and does nothing while ReelForge is closed.

## Run it in a browser

```bash
npm install
npm run dev
```

Open the address it prints, in current Chrome or Edge.

## Publish it

```bash
npm run build
```

Upload the `dist` folder to any static host, such as Netlify, Cloudflare Pages or GitHub Pages. Paths are relative, so it also works from a subfolder. It must be served over HTTP or HTTPS; opening `index.html` from disk won't work.

## Test it

Needs Chrome or Edge, and `ffmpeg` and `ffprobe` on your PATH. It uses no keys and costs nothing, because a local stand-in answers for Anthropic and ElevenLabs.

```bash
npm test
```

Screenshots and the rendered video go to `test-output`.

## How it works

| Part | File | What it does |
| --- | --- | --- |
| Agent | `src/lib/agent.ts` | Claude Opus 5.5 loop, tools, budget, long-job handoff |
| API client | `src/lib/claude.ts` | Official Anthropic SDK, streaming, strict tool input checks |
| Video | `src/lib/render.ts` | Page to picture, footage decoding, sound mix, H.264 and AAC through WebCodecs |
| Film sandbox | `public/frame.html` | Runs each film page with no origin and no network |
| Storage | `src/lib/db.ts` | IndexedDB for settings, conversations and files |
| Know-how | `public/skills` | System prompt, skills and example scenes |
| Shared assets | `public/runtime` | GSAP, motion kit, Bengali fonts, sound effects |

## Limits

- **Browsers:** made for Chrome and Edge. Safari can't draw the frames, and the app says so when it opens.
- **Keys:** stored unencrypted in this browser's storage. Film pages can't reach them, and the published build can only connect to Anthropic and ElevenLabs. Still, don't save keys on a shared computer.
- **Keep the tab open:** closing it stops the work. Press Continue afterwards.
- **Footage:** a clip plays whole from its start, with overlays, captions and sound added on top. In a browser, HEVC footage only works where the browser can decode it; the desktop app converts it.
- **Hearing:** the agent can't hear, so listen before publishing. It also can't watch a video from a link.
- **Public hosting:** `public/skills/examples` contains text from an earlier client film. Remove or rewrite those scenes before publishing the site publicly.
