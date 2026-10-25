import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context';
type Tool = { id: string; name: string; kind: string; executable?: string; args?: string[]; input?: string; timeoutMs?: number; readiness?: { ready: boolean; message: string } };
type Config = { version: string; defaultToolId: string; tools: Tool[] };
type Draft = Tool & { argsText: string };
export function AiToolSettings() {
  const { t } = useI18n();
  const [config, setConfig] = useState<Config | null>(null), [tools, setTools] = useState<Draft[]>([]);
  const [selected, setSelected] = useState('codex'), [error, setError] = useState(''), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const response = await fetch('/api/ai-tools'); const data = await response.json();
      if (!response.ok || !Array.isArray(data.tools)) throw new Error(data.message || t('aiTools.loadError'));
      setConfig(data); setSelected(data.defaultToolId); setTools(data.tools.map((tool: Tool) => ({ ...tool, argsText: JSON.stringify(tool.args || []) }))); setError(''); setSaved(false);
    } catch (e) { setError(e instanceof Error ? e.message : t('aiTools.loadError')); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  function edit(index: number, patch: Partial<Draft>) { setSaved(false); setTools(old => old.map((tool, i) => i === index ? { ...tool, ...patch, readiness: undefined } : tool)); }
  async function save() {
    setBusy(true); setSaved(false); setError('');
    try {
      const body = { version: config!.version, defaultToolId: selected, tools: tools.map(({ argsText, ...tool }) => tool.kind === 'codex' ? tool : { ...tool, args: JSON.parse(argsText) }) };
      const response = await fetch('/api/ai-tools', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error([data.message || t('aiTools.saveError'), data.work?.map((work: { changeName: string }) => work.changeName).join(', ')].filter(Boolean).join(' · '));
      setConfig(data); setTools(data.tools.map((tool: Tool) => ({ ...tool, argsText: JSON.stringify(tool.args || []) }))); setSaved(true);
    } catch (e) { setError(e instanceof SyntaxError ? t('aiTools.argsError') : e instanceof Error ? e.message : t('aiTools.saveError')); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 border-t pt-4" aria-label={t('aiTools.title')}>
    <h3>{t('aiTools.title')}</h3><p className="text-sm text-muted-foreground">{t('aiTools.hint')}</p>
    {error && <p role="alert">{error}</p>}{saved && <p role="status">{t('aiTools.saved')}</p>}
    {config && <>
      <label className="block">{t('aiTools.default')}<select className="block w-full border rounded p-2" disabled={busy} value={selected} onChange={e => { setSelected(e.target.value); setSaved(false); }}>{tools.map((tool, i) => <option key={i} value={tool.id}>{tool.name || tool.id}</option>)}</select></label>
      {tools.map((tool, index) => <fieldset disabled={busy} className="border rounded p-3 space-y-2" key={index}>
        <legend>{tool.name || t('aiTools.new')}</legend>
        {tool.readiness && <p role="status">{tool.readiness.message}</p>}
        {tool.kind === 'external-cli' && <>
          <label className="block">{t('aiTools.id')}<input className="block w-full border p-1" value={tool.id} onChange={e => { const value = e.target.value; if (selected === tool.id) setSelected(value); edit(index, { id: value }); }} /></label>
          <label className="block">{t('aiTools.name')}<input className="block w-full border p-1" value={tool.name} onChange={e => edit(index, { name: e.target.value })} /></label>
          <label className="block">{t('aiTools.executable')}<input className="block w-full border p-1" value={tool.executable} onChange={e => edit(index, { executable: e.target.value })} /></label>
          <label className="block">{t('aiTools.args')}<textarea className="block w-full border p-1" value={tool.argsText} onChange={e => edit(index, { argsText: e.target.value })} /></label>
          <label className="block">{t('aiTools.input')}<select value={tool.input} onChange={e => edit(index, { input: e.target.value })}><option value="stdin">stdin</option><option value="argument">{'{prompt}'}</option></select></label>
          <label className="block">{t('aiTools.timeout')}<input type="number" min="1" max="86400000" value={tool.timeoutMs} onChange={e => edit(index, { timeoutMs: Number(e.target.value) })} /></label>
          <p className="text-sm">{t('aiTools.limitations')}</p>
          <button type="button" onClick={() => { setTools(tools.filter((_, i) => i !== index)); if (selected === tool.id) setSelected('codex'); setSaved(false); }}>{t('aiTools.delete')}</button>
        </>}
      </fieldset>)}
      <div className="flex gap-3"><button disabled={busy} onClick={() => { setTools([...tools, { id: `external-${tools.length}`, name: '', kind: 'external-cli', executable: '', argsText: '[]', input: 'stdin', timeoutMs: 600000 }]); setSaved(false); }}>{t('aiTools.add')}</button><button disabled={busy} onClick={() => void save()}>{t('aiTools.save')}</button></div>
    </>}
    <button disabled={busy} onClick={() => void load()}>{t('aiTools.reload')}</button>
  </section>;
}
