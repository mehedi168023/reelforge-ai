import { useRef, useState } from 'react';
import { AgentController, CONTENT_TYPES, STYLES } from '../lib/agent';
import { activeVoiceName, createProject, settings, voiceReady, type ProjectMeta } from '../lib/store';
import { BackLink, FileThumb, sizeLabel } from '../ui';

const SHAPES = [
  ['source', 'Match footage'],
  ['16:9', '16:9'],
  ['9:16', '9:16'],
  ['1:1', '1:1'],
];
const LANGUAGES = [
  ['auto', 'Same as speech'],
  ['Bengali', 'Bengali'],
  ['English', 'English'],
  ['Banglish', 'Banglish'],
];

function Choices({ label, options, value, onChange }: { label: string; options: string[][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="choices" role="radiogroup" aria-label={label}>
      {options.map(([id, title]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={`choice ${value === id ? 'on' : ''}`} onClick={() => onChange(id)}>
          {title}
        </button>
      ))}
    </div>
  );
}

function Toggle({ title, hint, value, disabled, onChange }: { title: string; hint: string; value: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`toggle ${disabled ? 'off' : ''}`}>
      <span>
        <strong>{title}</strong>
        <span className="hint">{hint}</span>
      </span>
      <input type="checkbox" role="switch" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function NewVideoScreen({ onCreated }: { onCreated: (meta: ProjectMeta) => void }) {
  const [type, setType] = useState('edit');
  const [brief, setBrief] = useState(CONTENT_TYPES.edit.brief);
  const [style, setStyle] = useState('auto');
  const [aspect, setAspect] = useState('source');
  const [language, setLanguage] = useState('auto');
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [autopilot, setAutopilot] = useState(false);
  const [voiceover, setVoiceover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const pickType = (id: string) => {
    const untouched = !brief.trim() || Object.values(CONTENT_TYPES).some((t) => t.brief === brief);
    setType(id);
    if (untouched) setBrief(CONTENT_TYPES[id].brief);
    if (id === 'edit') setAspect('source');
    else if (aspect === 'source') setAspect('16:9');
  };

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const added = [...list];
    setFiles((f) => [...f, ...added]);
    setName((n) => n || added[0].name.replace(/\.[^.]+$/, ''));
  };

  const start = async () => {
    if (!settings.anthropicKey) return setError('Add your API key in Settings first.');
    if (!brief.trim() && !files.length) return setError('Describe the video, or add a file.');
    setBusy(true);
    setError(null);
    try {
      // Asks the browser not to clear these files when disk space runs low.
      await navigator.storage?.persist?.();
      const meta = await createProject({ name: name.trim() || brief.trim().split('\n')[0], type, style, aspect, language, autopilot, voiceover }, files);
      const c = await AgentController.of(meta);
      void c.send(brief.trim() || 'Start this video.', c.firstPrompt(brief));
      onCreated(meta);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page narrow with-footer">
      <BackLink />
      <h1>New video</h1>

      <h2 className="label">What are you making?</h2>
      <Choices label="Content type" options={Object.entries(CONTENT_TYPES).map(([id, t]) => [id, t.title])} value={type} onChange={pickType} />
      <p className="hint">{CONTENT_TYPES[type].blurb}</p>

      <h2 className="label"><label htmlFor="brief">Brief</label></h2>
      <textarea id="brief" rows={6} placeholder="Describe the video. Replace any [brackets]." value={brief} onChange={(e) => setBrief(e.target.value)} />

      <h2 className="label">Files</h2>
      <div
        className={`drop ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <input ref={input} data-testid="file-input" type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" className="btn" onClick={() => input.current?.click()}>Add footage, voice, logo or screenshots</button>
        <span className="hint drop-hint">or drop them here</span>
      </div>
      {files.map((f, i) => (
        <div className="file-row" key={`${f.name}${i}`}>
          <FileThumb file={f} />
          <span className="file-name">{f.name}</span>
          <span className="hint">{sizeLabel(f.size)}</span>
          <button type="button" className="icon-btn small" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}

      <h2 className="label">Style</h2>
      <div className="style-grid" role="radiogroup" aria-label="Style">
        {Object.entries(STYLES).map(([id, s]) => (
          <button key={id} type="button" role="radio" aria-checked={style === id} className={`style-card ${style === id ? 'on' : ''}`} onClick={() => setStyle(id)}>
            <strong>{s.title}</strong>
            <span className="hint">{s.blurb}</span>
          </button>
        ))}
      </div>

      <h2 className="label">Shape</h2>
      <Choices label="Shape" options={SHAPES} value={aspect} onChange={setAspect} />

      <h2 className="label">On-screen language</h2>
      <Choices label="On-screen language" options={LANGUAGES} value={language} onChange={setLanguage} />

      <h2 className="label"><label htmlFor="name">Name</label></h2>
      <input id="name" placeholder="Name this video" value={name} onChange={(e) => setName(e.target.value)} />

      <Toggle title="Make the voiceover from your script" hint={voiceReady() ? `Speaks your script with ${activeVoiceName()}, using your credits.` : 'Set up a voice provider in Settings first.'} value={voiceover} disabled={!voiceReady()} onChange={setVoiceover} />
      <Toggle title="Autopilot" hint="Goes straight to the finished video. Costs more if the first direction is wrong." value={autopilot} onChange={setAutopilot} />

      <div className="page-footer">
        {error && <p className="msg bad" role="alert">{error}</p>}
        <button className="btn primary wide" disabled={busy} onClick={start}>
          {busy ? 'Preparing...' : 'Start'}
        </button>
      </div>
    </div>
  );
}
