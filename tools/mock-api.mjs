// Stands in for Anthropic and ElevenLabs, so the web app's whole flow can be tested for free.
// Usage: node tools/mock-api.mjs [port] [mp3 file] [folder of test files]. Results: GET /__log
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.argv[2] || 8799);
const MP3 = process.argv[3];
const log = { requests: [], problems: [], lastBody: null };
let n = 0;
const problem = (m) => { log.problems.push(m); console.log("PROBLEM:", m); };

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<script>window.onerror=function(m){window.__rfError=String(m)}</script>
<script src="assets/gsap.min.js"></script><script src="assets/kit.js"></script>
<style>
@font-face{font-family:'Anek Bangla';src:url('assets/fonts/anek-bangla.woff2');font-weight:500 800}
*{margin:0;box-sizing:border-box}html,body{width:1280px;height:720px;overflow:hidden;background:transparent}
h1{position:absolute;left:0;right:0;top:300px;text-align:center;font:800 90px 'Anek Bangla';color:#fff;background:#ff7a1a;padding:10px}
#fx{position:absolute;inset:0}#dot{position:absolute;left:100px;top:100px;width:120px;height:120px;border-radius:50%;background:#38c98a}
</style></head><body><div id="fx"></div><div id="dot"></div><h1 id="t">ভিডিও এডিট করুন</h1>
<script>const tl=window.__tl=gsap.timeline({paused:true});
tl.fromTo('#dot',{x:0},{x:1000,duration:3,ease:'none'},0);FF.pop(tl,'#t',0.3);FF.ring(tl,'#fx',1,{x:640,y:360,r:300,color:'#fff'});FF.burst(tl,'#fx',1,{x:640,y:360,n:20,kind:'spark',r:300,seed:3});
</script></body></html>`;

const tool = (name, input, id) => ({ type: "tool_use", id: id || `toolu_${++n}`, name, input });

// The script of a job. Each entry answers the next request; the fourth entry tests broken input.
const STEPS = [
  () => [{ type: "thinking", thinking: "plan the audit", signature: "sig-abc" }, tool("read_skill", { name: "edit" }), tool("media_info", { path: "input/clip.mp4" }), tool("video_frames", { path: "input/clip.mp4", times: [0.5, 1.5] })],
  () => "AUDIT",
  () => [tool("write_file", { path: "index.html", contents: PAGE }), tool("write_file", { path: "project.json", contents: JSON.stringify({ width: 1280, height: 720, fps: 30, duration: 3, footage: "input/clip.mp4", grade: { brightness: 0.95, contrast: 1.15, saturation: 0.9, tint: "#2a5cff", tintAmount: 0.12, vignette: 0.45 }, camera: [{ t: 0, zoom: 1.2, ease: "cut" }, { t: 0.1, zoom: 1, dur: 0.5 }, { t: 1.5, zoom: 1.3, y: 0.4, ease: "cut" }, { t: 1.5, shake: 12 }, { t: 2.2, zoom: 1, ease: "push", dur: 0.8 }], audio: [{ file: "input/voice.mp3", start: 0.2, volume: 1 }, { file: "assets/sfx/pop.mp3", start: 1, volume: 0.4 }] }) })],
  () => "BROKEN",
  () => [tool("snapshot", { times: [0.5, 1.2, 2.5] })],
  () => [tool("generate_voice", { text: "ভিডিও এডিট করুন", out: "assets/vo.mp3", language: "bn" }), tool("transcribe", { path: "assets/vo.mp3", language: "bn" })],
  () => "PAUSE",
  () => [tool("render", {})],
  () => [tool("video_frames", { path: "renders/video-1.mp4", times: [1] }), tool("media_info", { path: "renders/video-1.mp4" })],
  () => "DONE",
];
let step = 0;
let scenario = "job";
const frames = (k) => [tool("snapshot", { times: Array.from({ length: 12 }, (_, i) => k + i / 10) })];
const HANDOFF = [() => [tool("write_file", { path: "index.html", contents: PAGE }), tool("write_file", { path: "project.json", contents: JSON.stringify({ width: 1280, height: 720, fps: 30, duration: 20 }) })], ...[0, 1, 2, 3, 4, 5, 6].map((k) => () => frames(k)), () => "DONE"];

function sse(res, content, stop, extra = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`);
  send("message_start", { message: { id: `msg_${++n}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 500 } } });
  send("ping", {});
  content.forEach((b, index) => {
    if (b.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const piece of b.text.match(/[\s\S]{1,40}/g)) send("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
    } else if (b.type === "thinking") {
      send("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.thinking } });
      send("content_block_delta", { index, delta: { type: "signature_delta", signature: b.signature } });
    } else {
      send("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const raw = b.raw ?? JSON.stringify(b.input);
      for (const piece of raw.match(/[\s\S]{1,200}/g)) send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: piece } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: stop, ...extra }, usage: { output_tokens: 500 } });
  send("message_stop", {});
  res.end();
}

function check(req, p) {
  if (req.headers["anthropic-beta"] !== "server-side-fallback-2026-07-01") problem("missing fallback beta header");
  if (p.model !== "claude-opus-5-5" || p.fallbacks !== "default" || p.stream !== true) problem("wrong model, fallbacks or stream");
  if (p.thinking?.type !== "adaptive" || !p.output_config?.effort || p.cache_control?.type !== "ephemeral") problem("wrong thinking, effort or cache");
  if ("temperature" in p || "tool_choice" in p) problem("sent a parameter the model rejects");
  if (p.tools.filter((t) => t.input_schema).some((t) => t.eager_input_streaming !== true)) problem("tool without eager streaming");
  // Every tool call must be answered in the very next message, and thinking replayed unchanged.
  p.messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    const calls = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    const next = p.messages[i + 1];
    const answered = (next?.content || []).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    for (const c of calls) if (!answered.includes(c)) problem(`tool call ${c} unanswered at message ${i}`);
    if (m.content.some((b) => JSON.stringify(b).includes("_invalidJson"))) problem("internal marker leaked into history");
  });
  const thinking = p.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "thinking");
  if (scenario === "job" && step > 1 && !thinking.some((t) => t.thinking === "plan the audit" && t.signature === "sig-abc")) problem("thinking block changed or lost");
}

http.createServer((req, res) => {
  // The browser calls this from another port, exactly as it calls the real APIs from another site.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] || "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = req.url;
    if (url.startsWith("/__log")) return res.end(JSON.stringify({ ...log, step, lastBody: undefined }, null, 1));
    if (url.startsWith("/__reset")) { step = 0; scenario = url.includes("handoff") ? "handoff" : "job"; log.problems = []; log.requests = []; return res.end("ok"); }
    if (url.startsWith("/__upload")) { fs.writeFileSync(decodeURIComponent(url.split("?")[1]), body); return res.end("saved " + body.length); }
    if (url.startsWith("/files/")) { res.setHeader("content-type", "application/octet-stream"); return res.end(fs.readFileSync(process.argv[4] + "/" + url.slice(7))); }
    if (url.startsWith("/__last")) return res.end(JSON.stringify(log.lastBody));
    log.requests.push(`${req.method} ${url} ${body.length}b`);
    if (url.startsWith("/v1/models")) {
      res.writeHead(/bad-key/.test(`${req.headers["x-api-key"]} ${req.headers.authorization}`) ? 401 : 200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "claude-opus-5-5" }));
    }
    if (url.startsWith("/v1/voices/")) {
      if (url.includes("bad")) { res.writeHead(404); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ voice_id: "v", name: "Mock Voice" }));
    }
    if (url.startsWith("/v1/text-to-speech/")) {
      const b = JSON.parse(body);
      if (!req.headers["xi-api-key"] || !b.text || !b.model_id || !url.includes("output_format=")) problem("bad TTS request");
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(fs.readFileSync(MP3));
    }
    if (url.startsWith("/v1/speech-to-text")) {
      if (!String(req.headers["content-type"]).startsWith("multipart/form-data")) problem("bad STT request");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ words: [{ text: "ভিডিও", type: "word", start: 0.1, end: 0.5 }, { text: " ", type: "spacing", start: 0.5, end: 0.6 }, { text: "এডিট", type: "word", start: 0.6, end: 1 }] }));
    }
    if (url.startsWith("/v1/messages")) {
      const p = JSON.parse(body);
      log.lastBody = p;
      check(req, p);
      const lastMsg = p.messages[p.messages.length - 1];
      if (JSON.stringify(lastMsg.content).includes("handoff note for yourself")) {
        log.handoffAskAt = p.messages.length;
        return sse(res, [{ type: "text", text: "NOTE: built index.html; left: finish." }], "end_turn");
      }
      if (log.handoffAskAt && !log.handoffChecked) {
        log.handoffChecked = true;
        const t = JSON.stringify(p.messages);
        log.afterHandoff = { messages: p.messages.length, hasNote: t.includes("NOTE: built index.html"), hasBrief: t.includes("New video job"), hasImages: t.includes('"image"') };
      }
      const script = scenario === "handoff" ? HANDOFF : STEPS;
      const s = script[Math.min(step, script.length - 1)]();
      step++;
      if (s === "AUDIT") return sse(res, [{ type: "text", text: "## What this video is\nA short **test** clip.\n\n## What can be improved\n1. t=0.5s Add a title.\n- Add sound\n\nApprove to continue." }], "end_turn");
      if (s === "BROKEN") return sse(res, [{ ...tool("write_file", {}), raw: '{"path": "x.txt", "contents": "cut' }], "tool_use");
      if (s === "PAUSE") return sse(res, [{ type: "text", text: "Checking." }], "pause_turn");
      if (s === "DONE") return sse(res, [{ type: "text", text: "Done. What I measured: length and frames. I could not hear the sound, so please listen." }], "end_turn");
      return sse(res, s, "tool_use");
    }
    res.writeHead(404);
    res.end("{}");
  });
}).listen(PORT, () => console.log("mock on", PORT));
