import { useEffect, useRef, useState } from 'react';
import { testKey } from '../lib/claude';
import { kvSet } from '../lib/db';
import { checkVoice } from '../lib/eleven';
import { checkVoice as checkCartesiaVoice } from '../lib/cartesia';
import { addSkill, listSkills, removeSkill, saveSettings, settings, type MySkill, type Settings as S } from '../lib/store';
import { BackLink, Logo, Section } from '../ui';
import { desktop, detectEngines, ENGINE_LABEL, ENGINE_MODELS, type EngineInfo } from '../lib/desktop';

/** Picks which AI makes the videos: the Anthropic API, or an AI CLI found on this PC. */
export function EnginePicker({ onPicked }: { onPicked?: (id: string) => void }) {
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [picked, setPicked] = useState(settings.engine);
  const [model, setModel] = useState(settings.engineModels[settings.engine] ?? '');
  const [scanning, setScanning] = useState(false);

  const scan = async (fresh: boolean) => {
    setScanning(true);
    setEngines(await detectEngines(fresh));
    setScanning(false);
  };
  useEffect(() => {
    void scan(false);
  }, []);

  const choose = async (id: string) => {
    settings.engine = id;
    await saveSettings();
    setPicked(id);
    setModel(settings.engineModels[id] ?? '');
    onPicked?.(id);
  };

  const saveModel = async (value: string) => {
    setModel(value);
    settings.engineModels = { ...settings.engineModels, [picked]: value.trim() };
    await saveSettings();
  };

  const rows: { id: string; name: string; sub: string; ok: boolean }[] = [
    { id: 'api', name: ENGINE_LABEL.api, sub: settings.anthropicKey ? 'Pays per use from your Anthropic account. Built in, works without any CLI.' : 'Needs an Anthropic API key (below).', ok: true },
    ...(engines ?? []).map((e) => ({
      id: e.id,
      name: e.name,
      sub: e.installed ? `Installed${e.version ? `: ${e.version}` : ''}. Uses your ${e.name} sign-in or plan.` : `Not found. ${e.install}.`,
      ok: e.installed,
    })),
  ];

  return (
    <div className="engine-picker">
      <div className="engine-list" role="radiogroup" aria-label="AI engine">
        {rows.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={picked === r.id} disabled={!r.ok} className={`engine-card ${picked === r.id ? 'on' : ''} ${r.ok ? '' : 'missing'}`} onClick={() => choose(r.id)}>
            <span className={`engine-dot ${r.ok ? 'ok' : ''}`} aria-hidden="true" />
            <span className="engine-text">
              <strong>{r.name}</strong>
              <span className="hint">{r.sub}</span>
            </span>
          </button>
        ))}
        {engines === null && <p className="hint">Looking for AI tools on this PC...</p>}
      </div>
      {picked !== 'api' && (
        <label>
          Model
          <input list={`models-${picked}`} placeholder={`${ENGINE_LABEL[picked]} default`} value={model} onChange={(e) => saveModel(e.target.value)} spellCheck={false} />
          <datalist id={`models-${picked}`}>
            {(ENGINE_MODELS[picked] ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <span className="hint">Leave empty to use the CLI's own default model. It must be able to see images, because the agent checks frames.</span>
        </label>
      )}
      <button type="button" className="btn text" disabled={scanning} onClick={() => scan(true)}>
        {scanning ? 'Scanning...' : 'Scan this PC again'}
      </button>
    </div>
  );
}

const saveKey = (name: 'anthropicKey' | 'elevenKey', value: string) => {
  settings[name] = value;
  return kvSet('settings', { ...settings });
};

const secretProps = { type: 'password', autoComplete: 'off', spellCheck: false, autoCapitalize: 'off' } as const;

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('');
  const [engine, setEngine] = useState(settings.engine);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = key.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    const problem = await testKey(value);
    if (problem) {
      setBusy(false);
      setError(problem);
      return;
    }
    await saveKey('anthropicKey', value);
    settings.engine = 'api';
    await saveSettings();
    onDone();
  };

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="brand big">
          <Logo size={44} />
          <span>ReelForge</span>
        </div>
        <p className="lead">Describe a video and get a finished MP4, made right here {desktop ? 'on your PC' : 'in your browser'}.</p>
        {desktop && (
          <Section title="Pick your AI" hint="Use an AI you already have on this PC (no API key needed), or add an Anthropic API key below.">
            <EnginePicker onPicked={setEngine} />
            <button className="btn primary" disabled={engine === 'api'} onClick={onDone}>
              {engine === 'api' ? 'Add your API key below, or pick an AI' : 'Start with the selected AI'}
            </button>
          </Section>
        )}
        <form onSubmit={save}>
          <Section title="Anthropic API key" hint={`From console.anthropic.com. It stays ${desktop ? 'on this PC' : 'in this browser'} and goes only to Anthropic, which bills that account for use. Don't save it on a shared computer.`}>
            <input {...secretProps} aria-label="Anthropic API key" placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} />
            {error && <p className="msg bad" role="alert">{error}</p>}
            <button className="btn primary" disabled={busy || !key.trim()}>
              {busy ? 'Testing...' : 'Save and start'}
            </button>
          </Section>
        </form>
      </div>
    </div>
  );
}

export function SettingsScreen() {
  const [, repaint] = useState(0);
  const refresh = () => repaint((n) => n + 1);
  const [anthropic, setAnthropic] = useState('');
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [eleven, setEleven] = useState('');
  const [voice, setVoice] = useState(settings.voiceId);
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [cartKey, setCartKey] = useState('');
  const [cartVoice, setCartVoice] = useState(settings.cartesiaVoiceId);
  const [cartMsg, setCartMsg] = useState<string | null>(null);
  const [cartBusy, setCartBusy] = useState(false);
  const [master, setMaster] = useState(settings.masterPrompt);
  const [masterMsg, setMasterMsg] = useState<string | null>(null);
  const [skills, setSkills] = useState<MySkill[]>([]);
  const [skillMsg, setSkillMsg] = useState<string | null>(null);
  const skillInput = useRef<HTMLInputElement>(null);

  const loadSkills = () => listSkills().then(setSkills);
  useEffect(() => {
    loadSkills();
  }, []);

  const set = <K extends keyof S>(key: K, value: S[K]) => {
    settings[key] = value;
    saveSettings();
    refresh();
  };

  const saveAnthropic = async () => {
    const value = anthropic.trim();
    if (!value) return;
    setKeyMsg('Testing...');
    const problem = await testKey(value);
    if (!problem) {
      await saveKey('anthropicKey', value);
      setAnthropic('');
    }
    setKeyMsg(problem ?? 'Saved and working.');
  };

  const saveVoice = async () => {
    const key = eleven.trim() || settings.elevenKey;
    const id = voice.trim();
    if (!key || !id) return setVoiceMsg('Add both the API key and the voice ID.');
    setVoiceBusy(true);
    setVoiceMsg('Testing with ElevenLabs. This uses no credits.');
    try {
      const name = await checkVoice(key, id);
      Object.assign(settings, { elevenKey: key, voiceId: id, voiceName: name });
      await saveSettings();
      setEleven('');
      setVoiceMsg(`Ready: ${name}.`);
    } catch (err) {
      setVoiceMsg(err instanceof Error ? err.message : String(err));
    }
    setVoiceBusy(false);
  };

  const removeVoice = async () => {
    Object.assign(settings, { elevenKey: '', voiceId: '', voiceName: '' });
    await saveSettings();
    setVoice('');
    setVoiceMsg('Removed.');
  };

  const saveCartesia = async () => {
    const key = cartKey.trim() || settings.cartesiaKey;
    const id = cartVoice.trim();
    if (!key || !id) return setCartMsg('Add both the API key and the voice ID.');
    setCartBusy(true);
    setCartMsg('Testing with Cartesia. This uses no credits.');
    try {
      const name = await checkCartesiaVoice(key, id);
      Object.assign(settings, { cartesiaKey: key, cartesiaVoiceId: id, cartesiaVoiceName: name });
      await saveSettings();
      setCartKey('');
      setCartMsg(`Ready: ${name}.`);
    } catch (err) {
      setCartMsg(err instanceof Error ? err.message : String(err));
    }
    setCartBusy(false);
  };

  const removeCartesia = async () => {
    Object.assign(settings, { cartesiaKey: '', cartesiaVoiceId: '', cartesiaVoiceName: '' });
    await saveSettings();
    setCartVoice('');
    setCartMsg('Removed.');
  };

  const onSkillFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const name = await addSkill(await file.text());
      setSkillMsg(`Added ${name}. New messages can use it.`);
      await loadSkills();
    } catch (err) {
      setSkillMsg(err instanceof Error ? err.message : "That file can't be read as a skill.");
    }
  };

  return (
    <div className="page narrow">
      <BackLink />
      <h1>Settings</h1>

      {desktop && (
        <Section title="AI engine" hint="Which AI makes your videos. CLIs on this PC use your own sign-in and plan, and get the same video tools through ReelForge.">
          <EnginePicker />
        </Section>
      )}

      <Section title="Anthropic API key" hint={settings.anthropicKey ? `Saved, ending ${settings.anthropicKey.slice(-4)}. Paste a new one to replace it.` : undefined}>
        <input {...secretProps} aria-label="New Anthropic API key" placeholder="sk-ant-..." value={anthropic} onChange={(e) => setAnthropic(e.target.value)} />
        {keyMsg && <p className="msg">{keyMsg}</p>}
        <button className="btn" onClick={saveAnthropic}>Save key</button>
      </Section>

      <Section title="Voiceover" hint="Pick a provider for making voiceovers and measuring speech timing. The agent uses it only when a job asks, and it uses your credits.">
        <label>
          Provider
          <select value={settings.voiceProvider} onChange={(e) => set('voiceProvider', e.target.value as S['voiceProvider'])}>
            <option value="cartesia">Cartesia: cheaper, supports Bangla</option>
            <option value="elevenlabs">ElevenLabs</option>
          </select>
        </label>
      </Section>

      {settings.voiceProvider === 'cartesia' ? (
        <Section title="Cartesia voice" hint={settings.cartesiaVoiceId && settings.cartesiaKey ? `Ready: ${settings.cartesiaVoiceName}. Get your key and voice ID from play.cartesia.ai.` : 'Get an API key and a voice ID from play.cartesia.ai. Sonic supports Bengali.'}>
          <label>
            API key
            <input {...secretProps} placeholder={settings.cartesiaKey ? 'Saved. Paste to replace.' : 'sk_car_...'} value={cartKey} onChange={(e) => setCartKey(e.target.value)} />
          </label>
          <label>
            Voice ID
            <input autoComplete="off" spellCheck={false} value={cartVoice} onChange={(e) => setCartVoice(e.target.value)} />
          </label>
          <label>
            Model
            <select value={settings.cartesiaModel} onChange={(e) => set('cartesiaModel', e.target.value)}>
              <option value="sonic-3.6">Sonic 3.6: best, supports Bangla</option>
              <option value="sonic-3.5">Sonic 3.5: supports Bangla</option>
              <option value="sonic-3">Sonic 3: supports Bangla</option>
            </select>
          </label>
          {cartMsg && <p className="msg" role="status">{cartMsg}</p>}
          <div className="row">
            <button className="btn grow" disabled={cartBusy} onClick={saveCartesia}>Save and test</button>
            {settings.cartesiaKey && <button className="btn text bad" onClick={removeCartesia}>Remove</button>}
          </div>
        </Section>
      ) : (
        <Section title="ElevenLabs voice" hint={settings.voiceId && settings.elevenKey ? `Ready: ${settings.voiceName}. The agent makes a voice only when a job asks. It uses your ElevenLabs credits.` : 'Lets the agent make a voiceover and measure speech timing. It uses your ElevenLabs credits.'}>
          <label>
            API key
            <input {...secretProps} placeholder={settings.elevenKey ? 'Saved. Paste to replace.' : ''} value={eleven} onChange={(e) => setEleven(e.target.value)} />
          </label>
          <label>
            Voice ID
            <input autoComplete="off" spellCheck={false} value={voice} onChange={(e) => setVoice(e.target.value)} />
          </label>
          <label>
            Model
            <select value={settings.voiceModel} onChange={(e) => set('voiceModel', e.target.value)}>
              <option value="eleven_v4">Eleven v4: best, supports Bangla</option>
              <option value="eleven_v4_turbo">Eleven v4 Turbo: faster, supports Bangla</option>
              <option value="eleven_v3">Eleven v3: supports Bangla</option>
              <option value="eleven_multilingual_v2">Multilingual v2: no Bangla</option>
              <option value="eleven_flash_v2_5">Flash v2.5: fastest, no Bangla</option>
            </select>
          </label>
          {voiceMsg && <p className="msg" role="status">{voiceMsg}</p>}
          <div className="row">
            <button className="btn grow" disabled={voiceBusy} onClick={saveVoice}>Save and test</button>
            {settings.elevenKey && <button className="btn text bad" onClick={removeVoice}>Remove</button>}
          </div>
        </Section>
      )}

      <Section title="Master prompt" hint="Your standing instructions for every video: brand, style, language, habits. A brief can override it for one video.">
        <textarea rows={6} maxLength={20000} aria-label="Master prompt" placeholder="For example: Always use my brand colours. Keep captions in Banglish. End every video with my logo and website." value={master} onChange={(e) => setMaster(e.target.value)} />
        {masterMsg && <p className="msg">{masterMsg}</p>}
        <button
          className="btn"
          onClick={async () => {
            settings.masterPrompt = master;
            await saveSettings();
            setMasterMsg('Saved. New messages use it.');
          }}
        >
          Save
        </button>
      </Section>

      <Section title="My skills" hint="Add a skill file (SKILL.md). Add only skills you trust: a skill gives the agent instructions.">
        {skills.map((s) => (
          <div className="skill-row" key={s.name}>
            <div>
              <strong>{s.name}</strong>
              <p className="hint">{s.description}</p>
            </div>
            <button
              className="btn text bad"
              onClick={async () => {
                await removeSkill(s.name);
                await loadSkills();
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {skillMsg && <p className="msg" role="status">{skillMsg}</p>}
        <input ref={skillInput} data-testid="skill-input" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={onSkillFile} />
        <button className="btn" onClick={() => skillInput.current?.click()}>Add skill</button>
      </Section>

      <Section title="Agent and export" hint="Lower effort costs less. A larger export size takes longer to render.">
        <label>
          Export size
          <select value={settings.exportShortSide} onChange={(e) => set('exportShortSide', Number(e.target.value))}>
            <option value={720}>720p: fastest</option>
            <option value={1080}>1080p: recommended</option>
            <option value={1440}>1440p: slowest</option>
          </select>
        </label>
        <label>
          Effort
          <select value={settings.effort} onChange={(e) => set('effort', e.target.value as S['effort'])}>
            <option value="medium">Medium: lowest cost</option>
            <option value="high">High: recommended</option>
            <option value="xhigh">Extra high</option>
            <option value="max">Maximum: highest cost</option>
          </select>
        </label>
        <label>
          Budget limit for each project (USD)
          <input
            type="number"
            min={1}
            defaultValue={settings.budgetUsd}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n > 0) {
                settings.budgetUsd = n;
                saveSettings();
              }
            }}
          />
          <span className="hint">Estimated from token use; Anthropic's bill is final.</span>
        </label>
      </Section>

      {desktop ? (
        <p className="footnote">Videos are saved in your Videos\ReelForge folder. Keys stay on this PC, unencrypted, so don't save them on a shared computer. The budget limit applies only to the Claude API engine; CLIs use your own plan.</p>
      ) : (
        <p className="footnote">Powered by Claude Opus 5.5. If that model is busy or declines, Anthropic may answer with a fallback model. Keys and videos stay in this browser, unencrypted, so don't save keys on a shared computer. Clearing this site's data deletes them.</p>
      )}
    </div>
  );
}
