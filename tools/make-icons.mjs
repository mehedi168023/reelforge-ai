// Draws the app icon from public/favicon.svg into electron/icon.png and a multi-size electron/build/icon.ico.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const svg = fs.readFileSync('public/favicon.svg', 'utf8');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const pngs = await page.evaluate(async (svg, sizes) => {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  return sizes.map((s) => {
    const c = Object.assign(document.createElement('canvas'), { width: s, height: s });
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png').split(',')[1];
  });
}, svg, sizes);
await browser.close();

const bufs = pngs.map((b) => Buffer.from(b, 'base64'));
fs.mkdirSync('electron/build', { recursive: true });
fs.writeFileSync('electron/icon.png', bufs[sizes.indexOf(512)]);

// ICO with PNG-compressed entries (Windows Vista and later), up to 256 px.
const entries = sizes.filter((s) => s <= 256).map((s) => ({ s, data: bufs[sizes.indexOf(s)] }));
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(({ s, data }, i) => {
  const o = 6 + i * 16;
  header.writeUInt8(s === 256 ? 0 : s, o);
  header.writeUInt8(s === 256 ? 0 : s, o + 1);
  header.writeUInt8(0, o + 2);
  header.writeUInt8(0, o + 3);
  header.writeUInt16LE(1, o + 4);
  header.writeUInt16LE(32, o + 6);
  header.writeUInt32LE(data.length, o + 8);
  header.writeUInt32LE(offset, o + 12);
  offset += data.length;
});
fs.writeFileSync('electron/build/icon.ico', Buffer.concat([header, ...entries.map((e) => e.data)]));
console.log('icons written');
