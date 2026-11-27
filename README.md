# ReelForge Web

A React app that turns a brief and your files into a finished MP4, entirely in the browser. There is no server: you bring your own Anthropic key, and a voice provider (Cartesia or ElevenLabs) is optional for voiceover and speech timing.

## Run it

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
- **Footage:** a clip plays whole from its start, with overlays, captions and sound added on top. Cutting needs the desktop app.
- **Hearing:** the agent can't hear, so listen before publishing. It also can't watch a video from a link.
- **Public hosting:** `public/skills/examples` contains text from an earlier client film. Remove or rewrite those scenes before publishing the site publicly.
