import { memo, useEffect, useState, type ReactNode } from 'react';

export const money = (v: number) => `$${v.toFixed(2)}`;

/** A small preview of a picked file: the image itself, or a glyph for video, audio and other types. */
export function FileThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file]);
  if (url) return <img className="thumb" src={url} alt="" />;
  const glyph = file.type.startsWith('video/') ? '▶' : file.type.startsWith('audio/') ? '♪' : '◆';
  return <span className="thumb ph" aria-hidden="true">{glyph}</span>;
}

export const sizeLabel = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export const statusLabel = (s: string) => ({ working: 'Working', done: 'Done', waiting: 'Needs you', error: 'Error', stopped: 'Stopped' })[s] ?? 'New';

/** The app mark (public/logo.png). */
export const Logo = ({ size }: { size: number }) => <img className="logo-mark" src="logo.png" width={size} height={size} alt="" draggable={false} />;

export const StatusDot = ({ status }: { status: string }) => <span className={`dot ${status}`} aria-hidden="true" />;

export const StatusPill = ({ status }: { status: string }) => <span className={`pill ${status}`}>{statusLabel(status)}</span>;

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="section" id={`set-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} data-title={title}>
      <h2>{title}</h2>
      {hint && <p className="hint">{hint}</p>}
      <div className="section-body">{children}</div>
    </section>
  );
}

export function BackLink({ label = 'Back' }: { label?: string }) {
  return (
    <a className="back-link" href="#/">
      <span aria-hidden="true">←</span> {label}
    </a>
  );
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\*\*([^*]+)\*\*|`([^`]+)`/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? <strong key={m.index}>{m[1]}</strong> : <code key={m.index}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A small markdown reader for the agent's messages: headings, lists, bold and code. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const rows: ReactNode[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) return;
    const heading = /^#{1,4}\s+(.*)/.exec(line);
    const item = /^\s*([-*]|\d+\.)\s+(.*)/.exec(line);
    if (heading) rows.push(<h3 key={i}>{heading[1].replaceAll('**', '')}</h3>);
    else if (item)
      rows.push(
        <div className="md-item" key={i}>
          <span className="md-mark">{item[1] === '-' || item[1] === '*' ? '•' : item[1]}</span>
          <span>{inline(item[2])}</span>
        </div>,
      );
    else rows.push(<p key={i}>{inline(line)}</p>);
  });
  return <div className="md">{rows}</div>;
});
