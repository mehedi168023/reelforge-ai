// Text edits on the film page (index.html) from the editor. Text the person adds is kept as one small, tagged
// script per caption, so it can be changed or removed exactly; text the AI wrote is changed by replacing the
// string in its source.

export type TextStyle = 'neon' | 'card' | 'pop' | 'box' | 'plain';

export interface UserText {
  id: string;
  style: TextStyle;
  text: string;
  t: number;
  end: number;
  /** Vertical centre, as a fraction of the height. */
  y: number;
  color: string;
}

export const TEXT_STYLES: Record<TextStyle, { title: string; y: number; color: string }> = {
  neon: { title: 'Neon', y: 0.62, color: 'red' },
  card: { title: 'Glass card', y: 0.42, color: 'gold' },
  pop: { title: 'Word pop', y: 0.22, color: 'blue' },
  box: { title: 'Karaoke box', y: 0.62, color: 'purple' },
  plain: { title: 'Plain', y: 0.8, color: 'white' },
};

export const TEXT_COLORS = ['red', 'gold', 'purple', 'blue', 'green', 'pink', 'white'];

const TAG = /<script>\/\*rf-text (\{[\s\S]*?\})\*\/[\s\S]*?<\/script>\n?/g;

/** JSON that is safe inside a script and inside a comment. */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\//g, '\\/');

function code(u: UserText): string {
  const T = safeJson(u.text);
  const base = `t:${u.t},end:${u.end},y:H*${u.y},host:host`;
  const color = safeJson(u.color);
  switch (u.style) {
    case 'neon':
      return u.color === 'white' ? `RF.neonText(tl,{${base},lines:[{text:${T}}]})` : `RF.neonText(tl,{${base},lines:[{text:${T},color:${color}}]})`;
    case 'card':
      return `RF.glassCard(tl,{${base},text:${T},color:${color}})`;
    case 'pop':
      return `RF.wordPop(tl,{${base},text:${T},color:${color},accent:[${Math.max(0, u.text.trim().split(/\s+/).length - 1)}]})`;
    case 'box':
      return `RF.dashBox(tl,{${base},text:${T},color:${color}})`;
    default:
      // A plain caption: white with a soft shadow, no kit effect.
      return `(function(){var d=document.createElement('div');d.textContent=${T};d.style.cssText='position:absolute;left:8%;right:8%;top:'+(H*${u.y})+'px;transform:translateY(-50%);text-align:center;color:#fff;font:800 '+Math.round(W*0.06)+'px "Anek Bangla","Segoe UI",sans-serif;text-shadow:0 3px 14px rgba(0,0,0,.7);opacity:0';host.appendChild(d);tl.to(d,{opacity:1,duration:.2},${u.t});tl.to(d,{opacity:0,duration:.15},${Math.max(u.t, u.end - 0.15)});})()`;
  }
}

function script(u: UserText): string {
  // The person's captions keep timeline time on their own timeline (window.__tl2) and layer (#rf-user), so they
  // stay put when the footage under them is cut, while the AI's captions follow the footage.
  return `<script>/*rf-text ${safeJson(u)}*/(function(){if(!window.RF||!window.gsap)return;var tl=window.__tl2||(window.__tl2=gsap.timeline({paused:true})),W=innerWidth,H=innerHeight;var host=document.getElementById('rf-user');if(!host){host=document.createElement('div');host.id='rf-user';host.className='rf-layer';document.body.appendChild(host)}${code(u)};})();</script>\n`;
}

export function userTexts(html: string): UserText[] {
  const out: UserText[] = [];
  for (const m of html.matchAll(TAG)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // a broken tag is left alone
    }
  }
  return out;
}

/** Adds or replaces one of the person's captions. Loads the kit if the page doesn't already. */
export function putUserText(html: string, u: UserText): string {
  let found = false;
  let next = html.replace(TAG, (whole, json) => {
    try {
      if (JSON.parse(json).id === u.id) {
        found = true;
        return script(u);
      }
    } catch {
      // keep
    }
    return whole;
  });
  if (found) return next;
  if (!/assets\/reels\.js/.test(next)) next = insertBeforeBodyEnd(next, '<script src="assets/reels.js"></script>\n');
  return insertBeforeBodyEnd(next, script(u));
}

export function removeUserText(html: string, id: string): string {
  return html.replace(TAG, (whole, json) => {
    try {
      return JSON.parse(json).id === id ? '' : whole;
    } catch {
      return whole;
    }
  });
}

function insertBeforeBodyEnd(html: string, piece: string): string {
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i >= 0 ? html.slice(0, i) + piece + html.slice(i) : html + piece;
}

const escFor = (q: string, s: string) => s.replace(/\\/g, '\\\\').split(q).join(`\\${q}`);
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Changes a line of the AI's text: every place it appears as a quoted string in a script, or as text between
 * tags. Returns null when the line can't be found as written (then the AI should make the change).
 */
export function replaceText(html: string, from: string, to: string): string | null {
  const f = from.trim();
  if (!f) return null;
  let count = 0;
  let next = html;
  for (const q of ["'", '"', '`']) {
    const needle = q + escFor(q, f) + q;
    const parts = next.split(needle);
    if (parts.length > 1) {
      count += parts.length - 1;
      next = parts.join(q + escFor(q, to) + q);
    }
  }
  const tagNeedle = `>${escHtml(f)}<`;
  const tagParts = next.split(tagNeedle);
  if (tagParts.length > 1) {
    count += tagParts.length - 1;
    next = tagParts.join(`>${escHtml(to)}<`);
  }
  return count ? next : null;
}
