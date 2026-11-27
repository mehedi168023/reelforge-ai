// Runs the production build in a real browser against the mock APIs, with no keys and no cost.
// Usage: npm test     (set BROWSER to a Chrome or Edge path if neither is found)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = path.resolve('test-output');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browserPath = [process.env.BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && fs.existsSync(p));
if (!browserPath) throw new Error('No Chrome or Edge found. Set BROWSER to its path.');

// Test media, generated so the test needs nothing else.
const clip = path.join(OUT, 'clip.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
const voice = path.join(OUT, 'voice.mp3');
fs.copyFileSync('public/runtime/sfx/chime.mp3', voice);
const skill = path.join(OUT, 'SKILL.md');
fs.writeFileSync(skill, '---\nname: my-brand\ndescription: Test skill for brand colours\n---\nUse orange.\n');

const mock = spawn(process.execPath, ['tools/mock-api.mjs', '8799', voice, OUT], { stdio: 'inherit' });

// A plain static server, like any host the build might be put on.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/markdown', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
const site = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join('dist-test', url === '/' ? 'index.html' : url);
  if (!file.startsWith('dist-test') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(5198);

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures++;
};
const mockLog = () => fetch('http://localhost:8799/__log').then((r) => r.json());
const mockLast = () => fetch('http://localhost:8799/__last').then((r) => r.json());
const reset = (s = '') => fetch(`http://localhost:8799/__reset${s}`);

const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickText = async (text, selector = 'button, a') => {
    const ok = await page.evaluate((t, s) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim() === t);
      el?.click();
      return Boolean(el);
    }, text, selector);
    if (!ok) throw new Error(`Nothing to click: ${text}`);
  };
  const waitStatus = (status, timeout = 240000) => page.waitForFunction((s) => document.querySelector('.pill')?.textContent === s, { timeout }, status);
  const setField = async (selector, value) => {
    await page.click(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type(selector, value);
  };

  await page.goto('http://localhost:5198/');
  await page.waitForSelector('input[type=password]');
  await shot('01-setup');

  // Keys
  await setField('input[type=password]', 'bad-key');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role=alert]');
  check('a rejected key shows a clear message', (await page.$eval('[role=alert]', (e) => e.textContent)).includes('rejected'));
  await setField('input[type=password]', 'mock-key');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.sidebar');
  check('a good key opens the app', true);
  check('no browser warning shown', !(await page.$('.banner')));

  // Settings
  await page.goto('http://localhost:5198/#/settings');
  await page.waitForSelector('[data-testid=skill-input]');
  const label = (t) => page.evaluateHandle((x) => [...document.querySelectorAll('label')].find((l) => l.textContent.startsWith(x)).querySelector('input'), t);
  await (await label('API key')).type('mock-eleven');
  await (await label('Voice ID')).type('bad');
  await clickText('Save and test');
  await page.waitForFunction(() => document.body.innerText.includes("can't find this voice"));
  check('a wrong voice ID shows a clear message', true);
  const voiceField = await label('Voice ID');
  await voiceField.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await voiceField.type('mockvoice');
  await clickText('Save and test');
  await page.waitForFunction(() => document.body.innerText.includes('Ready: Mock Voice.'));
  check('a right voice ID is saved', true);
  await page.type('textarea', 'MASTERMARK_always_use_orange');
  await clickText('Save');
  await (await page.$('[data-testid=skill-input]')).uploadFile(skill);
  await page.waitForFunction(() => document.body.innerText.includes('Added my-brand'));
  check('Add skill works', true);
  await shot('02-settings');

  // A full job
  await reset();
  await page.goto('http://localhost:5198/#/new');
  await page.waitForSelector('[data-testid=file-input]');
  await (await page.$('[data-testid=file-input]')).uploadFile(clip, voice);
  await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 2);
  await shot('03-new-video');
  await clickText('Start');
  await waitStatus('Needs you');
  check('the audit runs, then waits for approval', (await page.$eval('.feed', (e) => e.innerText)).includes('What can be improved'));
  await shot('04-audit');

  const started = Date.now();
  await clickText('Approve and continue');
  await page.waitForSelector('.render-bar', { timeout: 120000 });
  await sleep(2500);
  await shot('05-rendering');
  await waitStatus('Done');
  check('the job finishes', true, `${Math.round((Date.now() - started) / 1000)}s after approval`);
  await page.waitForSelector('.video-panel video');
  await sleep(500);
  await shot('06-done');

  const log = await mockLog();
  check('API requests stay valid at every step', log.problems.length === 0, log.problems.join('; '));
  const last = await mockLast();
  check('the Master prompt reaches the agent', JSON.stringify(last.system).includes('MASTERMARK_always_use_orange'));
  check('added skills reach the agent', JSON.stringify(last.system).includes('my-brand'));
  check('the voice setup reaches the agent', JSON.stringify(last.system).includes('Mock Voice'));
  const results = last.messages.flatMap((m) => (m.role === 'user' ? m.content.filter((b) => b.type === 'tool_result') : []));
  const errors = results.filter((r) => r.is_error).map((r) => String(r.content).slice(0, 120));
  check('broken tool input goes back as an error', errors.length === 1 && errors[0].includes('INVALID_JSON'), errors.join(' | '));

  // The finished file
  const size = await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('reelforge'); q.onsuccess = () => r(q.result); });
    const keys = await new Promise((r) => { const q = db.transaction('files').objectStore('files').getAllKeys(); q.onsuccess = () => r(q.result); });
    const key = keys.find((k) => k.endsWith('renders/video-1.mp4'));
    const blob = await new Promise((r) => { const q = db.transaction('files').objectStore('files').get(key); q.onsuccess = () => r(q.result); });
    const form = await blob.arrayBuffer();
    const res = await fetch('http://localhost:8799/__upload?OUT', { method: 'POST', body: form });
    return { size: blob.size, saved: await res.text() };
  });
  const finalMp4 = path.join(OUT, 'final.mp4');
  fs.renameSync('OUT', finalMp4);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,nb_frames,duration', '-of', 'json', finalMp4]).toString());
  console.log('      ', JSON.stringify(probe.streams));
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  check('the MP4 has the right video', video?.width === 1280 && video?.height === 720 && Number(video?.nb_frames) === 90, `${size.size} bytes, ${video?.codec_name}`);
  check('the MP4 has sound', Boolean(audio), audio?.codec_name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', finalMp4, '-vf', "select='eq(n,15)+eq(n,45)+eq(n,80)',scale=426:-1,tile=3x1", '-fps_mode', 'passthrough', '-frames:v', '1', path.join(OUT, 'frames.jpg')]);

  // Stop, then Continue
  await reset();
  await page.type('.composer textarea', 'go');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.send') || document.querySelector('.pill')?.textContent === 'Done', { timeout: 60000 });
  await waitStatus('Needs you', 60000).catch(() => undefined);
  await page.type('.composer textarea', 'build');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.render-bar', { timeout: 60000 });
  await page.waitForFunction(() => /Rendering \d+/.test(document.querySelector('.render-bar')?.innerText ?? ''), { timeout: 60000 });
  await clickText('Stop');
  await waitStatus('Stopped', 30000);
  check('Stop halts a render', true);
  await clickText('Continue');
  await waitStatus('Done');
  const afterStop = await mockLog();
  check('Continue works after Stop', afterStop.problems.length === 0, afterStop.problems.join('; '));
  check('a stopped render leaves no broken file', (await page.$$('.video-actions select option')).length === 0);

  // A second finished render
  await reset();
  await page.type('.composer textarea', 'again');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.pill')?.textContent === 'Done' && document.querySelector('.quick'), { timeout: 60000 });
  await page.type('.composer textarea', 'build');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.video-actions select option').length === 2, { timeout: 240000 });
  await waitStatus('Done');
  const speed = JSON.stringify((await mockLast()).messages).match(/Rendered renders\/video-\d+\.mp4 in \d+s/g)?.pop();
  check('a new render becomes a new version', true, speed);

  // Coming back after a reload
  await page.reload();
  await page.waitForSelector('.feed');
  check('history survives a reload', (await page.$eval('.feed', (e) => e.innerText)).includes('What can be improved'));
  await page.waitForSelector('.video-panel video');
  const videos = await page.$$eval('.video-actions select option', (o) => o.length);
  check('every version is kept', videos === 2, `${videos} versions`);
  const atBottom = await page.$eval('.feed', (e) => e.scrollHeight - e.scrollTop - e.clientHeight < 60);
  check('the conversation opens at its latest message', atBottom);

  // A long job that fills the request's image limit
  await reset('?handoff');
  await page.goto('http://localhost:5198/#/new');
  await page.waitForSelector('#brief');
  await clickText('Anything else');
  await page.type('#brief', 'Make a test card');
  await clickText('Start');
  await waitStatus('Needs you');
  const handoff = (await mockLog()).afterHandoff;
  check('a full history restarts from its own notes', handoff?.messages === 1 && handoff.hasNote && handoff.hasBrief && !handoff.hasImages, JSON.stringify(handoff));

  // Phone and tablet sizes
  await page.setViewport({ width: 390, height: 780, isMobile: true, deviceScaleFactor: 2 });
  await page.goto('http://localhost:5198/#/');
  await page.waitForSelector('.project-row');
  await shot('07-phone-list');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('phone list fits the screen', (await overflow()) <= 0);
  await page.goto('http://localhost:5198/#/new');
  await page.waitForSelector('#brief');
  await shot('08-phone-new');
  check('phone form fits the screen', (await overflow()) <= 0);
  await page.goto('http://localhost:5198/#/');
  await page.waitForSelector('.project-row');
  await page.evaluate(() => [...document.querySelectorAll('.project-row')].find((r) => r.textContent.includes('clip')).click());
  await page.waitForSelector('.video-panel video');
  await sleep(400);
  await shot('09-phone-project');
  check('phone project fits the screen', (await overflow()) <= 0);
  await page.setViewport({ width: 820, height: 1100 });
  await sleep(300);
  await shot('10-tablet-project');

  const unexpected = consoleErrors.filter((e) => !e.includes('401') && !e.includes('404'));
  check('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | ').slice(0, 400));
} catch (err) {
  failures++;
  console.log('FAIL ', err);
} finally {
  await browser.close();
  site.close();
  mock.kill();
}
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
