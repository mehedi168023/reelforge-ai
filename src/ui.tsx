import { memo, useEffect, useId, useState, type ReactNode } from 'react';

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

export const Logo = ({ size }: { size: number }) => {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--accent-2)" />
          <stop offset="0.55" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--lime)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id})`} />
      <path d="M24 17v30l25-15z" fill="var(--ink)" />
    </svg>
  );
};

export const StatusDot = ({ status }: { status: string }) => <span className={`dot ${status}`} aria-hidden="true" />;

export const StatusPill = ({ status }: { status: string }) => <span className={`pill ${status}`}>{statusLabel(status)}</span>;

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="section">
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
