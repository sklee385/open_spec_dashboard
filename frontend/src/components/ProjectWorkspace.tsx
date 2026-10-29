import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/context';
import { enProjectCopy, koProjectCopy } from '../i18n/projectMessages';
import { useProjectWorkspace } from '../hooks/useProjectWorkspace';
import type { GitEntry, ProjectEntry } from '../types/project';
import { FileDiff } from './FileDiff';
import './ProjectWorkspace.css';

export type ProjectWorkScope = { id: string; sourceId: string; changeName: string; title?: string; executionPath?: string; phase: string };
export type ProjectWorkspaceProps = { sourceId: string | null; active?: boolean; onOpenWork?: () => void; onDirtyChange?: (dirty: boolean) => void; registerNavigationGuard?: (guard: () => Promise<boolean>) => void; workspaces?: ProjectWorkScope[]; workId?: string | null; onWorkScopeChange?: (id: string | null) => void };
type Management = 'file' | 'directory' | 'move' | 'delete';
export function ProjectWorkspace(props: ProjectWorkspaceProps) {
  return <ProjectWorkspaceContent key={JSON.stringify([props.sourceId, props.workId ?? null])} {...props} />;
}
function ProjectWorkspaceContent({ sourceId, active = true, onOpenWork, onDirtyChange, registerNavigationGuard, workspaces = [], workId = null, onWorkScopeChange }: ProjectWorkspaceProps) {
  const { locale } = useI18n();
  const t = (key: keyof typeof enProjectCopy) => (locale === 'ko' ? koProjectCopy : enProjectCopy)[key];
  const w = useProjectWorkspace(sourceId, active, workId);
  const [panel, setPanel] = useState('file'), [selected, setSelected] = useState<ProjectEntry | null>(null), [management, setManagement] = useState<Management | null>(null), [path, setPath] = useState('');
  const [message, setMessage] = useState(''), [branch, setBranch] = useState(''), [remote, setRemote] = useState(''), [confirmation, setConfirmation] = useState<'push' | null>(null);
  const [leave, setLeave] = useState(false), [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const leaveResolve = useRef<((value: boolean) => void) | null>(null);
  const guard = useCallback(() => { if (!w.dirty) return Promise.resolve(true); if (leaveResolve.current) return Promise.resolve(false); setLeave(true); return new Promise<boolean>(resolve => { leaveResolve.current = resolve; }); }, [w.dirty]);
  const resolveLeave = (value: boolean) => { setLeave(false); leaveResolve.current?.(value); leaveResolve.current = null; };
  useEffect(() => { registerNavigationGuard?.(guard); }, [guard, registerNavigationGuard]);
  useEffect(() => { onDirtyChange?.(w.dirty); }, [w.dirty, onDirtyChange]);
  useEffect(() => { const before = (event: BeforeUnloadEvent) => { if (w.dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before); }, [w.dirty]);
  // Dialogs and selections belong to the remote project resource being replaced.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSelected(null); setManagement(null); setConfirmation(null); setMessage(''); setBranch(''); setExpanded(new Set()); }, [sourceId, workId]);
  useEffect(() => () => { leaveResolve.current?.(false); }, []);
  const navigate = async (action: () => void | Promise<void>) => { if (await guard()) await action(); };
  const openFile = (entry: ProjectEntry) => void navigate(async () => { setSelected(entry); await w.openFile(entry.path); setPanel('file'); });
  const manage = (kind: Management) => { setManagement(kind); setPath(kind === 'move' ? selected?.path ?? w.file?.path ?? '' : w.directory ? `${w.directory}/` : ''); };
  const target = selected ?? (w.file ? { path: w.file.path, name: w.file.path, kind: 'file' as const, version: w.file.version } : null);
  const submitManagement = async () => {
    if (management !== 'delete' && !(await guard())) return;
    let ok = false;
    if (management === 'file' || management === 'directory') { ok = await w.mutate('/entries', { path, kind: management, ...(management === 'file' ? { content: '' } : {}) }); if (ok && management === 'file') { await w.openFile(path); setPanel('file'); } }
    if (management === 'move' && target) { ok = await w.moveEntry({ ...target, version: w.file?.path === target.path ? w.file.version : target.version }, path); if (ok && w.file && (w.file.path === target.path || w.file.path.startsWith(`${target.path}/`))) await w.openFile(`${path}${w.file.path.slice(target.path.length)}`); }
    if (management === 'delete' && w.file) { ok = await w.mutate('/file', { path: w.file.path, version: w.file.version, confirmed: true }, 'DELETE'); if (ok) w.clearFile(); }
    if (ok) { setManagement(null); setSelected(null); }
  };
  const status = w.status, entries = status?.entries ?? [];
  const locked = w.busy || w.operation?.status === 'running' || (w.operation?.status === 'uncertain' && !w.operation.reviewedAt);
  const cleanupRequired = !!status?.progress || entries.some(e => e.conflicted);
  const gitLocked = locked || !!status?.blocked || cleanupRequired;
  const clean = !w.dirty && entries.length === 0 && !status?.hiddenChanges && !status?.progress;
  const staged = entries.filter(e => !e.conflicted && !e.untracked && !!e.index?.trim() && e.index !== '.');
  const unstaged = entries.filter(e => !e.conflicted && !e.untracked && !!e.worktree?.trim() && e.worktree !== '.');
  const tree = (parent: string): ReactNode => {
    const page = w.query ? { entries: w.entries, nextCursor: w.cursor } : w.treePages[parent];
    if (!page) return null;
    return <ul>{page.entries.map(entry => <li key={entry.path} data-selected={selected?.path === entry.path}><button disabled={entry.kind === 'boundary'} aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined} title={entry.reason ?? entry.path} onClick={() => { if (entry.kind === 'directory') { setSelected(entry); setExpanded(old => { const next = new Set(old); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); if (!expanded.has(entry.path)) void w.loadTree(entry.path); } else openFile(entry); }}><span aria-hidden="true">{entry.kind === 'directory' ? expanded.has(entry.path) ? '▾ ' : '▸ ' : entry.kind === 'boundary' ? '⊘ ' : ''}</span>{entry.name}</button>{entry.reason && <small>{entry.reason}</small>}{entry.kind === 'directory' && expanded.has(entry.path) && !w.query && tree(entry.path)}</li>)}{page.nextCursor && <li><button onClick={() => void w.loadTree(parent, page.nextCursor!)}>{t('project.more')}</button></li>}</ul>;
  };
  const group = (title: keyof typeof enProjectCopy, files: GitEntry[], side: 'staged' | 'unstaged') => <section className="project-status-group"><h3>{t(title)} ({files.length})</h3>{files.map(entry => <div className="project-git-entry" key={`${title}:${entry.path}`}><button onClick={() => void navigate(async () => { await w.showDiff(entry.path, side); setPanel('file'); })}>{entry.path}</button>{entry.originalPath && <small>{t('project.original')}: {entry.originalPath}</small>}<div><button disabled={gitLocked || w.dirty} onClick={() => void w.run(side === 'staged' ? 'unstage' : 'stage', { paths: [entry.path] })}>{t(side === 'staged' ? 'project.unstage' : 'project.stage')}</button><button onClick={() => openFile({ path: entry.path, name: entry.path, kind: 'file' })}>{t('project.openFile')}</button></div></div>)}</section>;
  if (!sourceId) return <div className="project-empty">{t('project.choose')}</div>;
  return <section className="project-workspace" aria-label={t('project.title')}>
    <header className="project-toolbar"><h2>{t('project.title')}</h2><button disabled={w.busy} onClick={() => { void w.refresh(); void w.loadTree(); }}>{t('project.refresh')}</button>{onOpenWork && <button onClick={() => void navigate(onOpenWork)}>{t('project.work')}</button>}<nav className="project-mobile-tabs">{(['tree', 'file', 'git'] as const).map(tab => <button key={tab} aria-pressed={panel === tab} onClick={() => setPanel(tab)}>{t(`project.${tab}`)}</button>)}</nav></header>
    <div className="project-scope"><label>{t('project.scope')}<select aria-label={t('project.scope')} value={workId ?? ''} disabled={!onWorkScopeChange || w.busy} onChange={event => { const next = event.target.value || null; void navigate(() => { onWorkScopeChange?.(next); }); }}><option value="">{t('project.originalScope')}</option>{workspaces.filter(work => work.sourceId === sourceId && work.executionPath && !['completed', 'archived', 'cancelled', 'canceled'].includes(work.phase)).map(work => <option key={work.id} value={work.id}>{t('project.workScope')} · {work.title || work.changeName}</option>)}</select></label>{workId && <p>{t('project.workScopeHint')}</p>}</div>
    {w.error && <p role="alert" className="project-error">{w.error}</p>}
    {w.draftError && <p role="alert" className="project-error">{w.draftError}</p>}
    {w.draftNotice && <p role="status">{w.draftNotice}</p>}
    <div className="project-panels">
      <aside className="project-tree" data-active={panel === 'tree'} aria-label={t('project.tree')}>
        <input aria-label={t('project.search')} placeholder={t('project.search')} value={w.query} onChange={event => w.setQuery(event.target.value)} />
        <label><input type="checkbox" checked={w.hidden} onChange={event => w.setHidden(event.target.checked)} />{t('project.hidden')}</label>
        {w.ignoredUnavailable && <small>{t('project.filterUnavailable')}</small>}
        <div className="project-actions"><button disabled={locked} onClick={() => manage('file')}>{t('project.newFile')}</button><button disabled={locked} onClick={() => manage('directory')}>{t('project.newFolder')}</button></div>
        <div className="project-breadcrumb">/{w.directory}{w.directory && <button onClick={() => void w.loadTree(w.directory.split('/').slice(0, -1).join('/'))}>↑</button>}</div>
        {!w.entries.length && <p>{t('project.empty')}</p>}
        {tree('')}
        {target && <button disabled={locked} onClick={() => manage('move')}>{t('project.move')}</button>}
      </aside>
      <main className="project-editor" data-active={panel === 'file'}>
        {w.diff ? <><p>{t('project.base')}: {w.diff.base}</p>{w.diff.originalPath && <p>{t('project.original')}: {w.diff.originalPath}</p>}{w.diff.reason ? <p>{w.diff.reason}</p> : <FileDiff {...w.diff} />}</> : w.historical ? <><h3>{w.historical.path}</h3><p>{t(w.detail?.files.find(e => e.path === w.historical?.path)?.status === 'D' ? 'project.parentFile' : 'project.historical')} · {w.detail?.hash} · {w.historical.base}</p>{w.historical.content === null ? <p>{w.historical.reason ?? t('project.fileUnavailable')}</p> : <ProjectSource content={w.historical.content} />}</> : w.file ? <>
          <header className="project-file-header"><h3>{w.file.path}</h3><small>{w.file.encoding ?? t('project.readonly')} · {w.file.size} B · {w.file.newline} {w.file.bom ? '· BOM' : ''}</small>{w.dirty && <strong>{t('project.dirty')}</strong>}</header>
          <div className="project-actions"><button onClick={() => { void navigator.clipboard.writeText(w.file?.content ?? '').then(() => setCopied(true)).catch(err => w.setError(String(err))); }}>{t('project.copy')}</button>{copied && <small role="status">{t('project.copied')}</small>}{w.file.editable && !w.editing && <button disabled={locked} onClick={() => w.setEditing(true)}>{t('project.edit')}</button>}{w.editing && <><button disabled={locked || !w.dirty} onClick={() => void w.save()}>{t('project.save')}</button><button disabled={locked} onClick={w.discard}>{t('project.cancel')}</button></>}<button disabled={locked} onClick={() => manage('delete')}>{t('project.delete')}</button></div>
          {!w.file.editable && <p>{w.file.reason ?? t('project.restriction')}</p>}
          {w.editing ? <><textarea className="project-input" aria-label={t('project.content')} spellCheck={false} value={w.draft} onChange={event => w.setDraft(event.target.value)} /><ProjectSource content={w.draft} /></> : w.file.content !== null ? <ProjectSource content={w.file.content} /> : <p>{w.file.reason ?? t('project.fileUnavailable')}</p>}
          {w.latest && <section className="project-conflict"><h3>{t('project.latest')}</h3><FileDiff path={w.file.path} before={w.latest.content} after={w.draft} /><pre>{w.latest.content}</pre><button onClick={() => void navigate(() => w.openFile(w.file!.path))}>{t('project.reload')}</button></section>}
        </> : <p>{t('project.pick')}</p>}
      </main>
      <aside className="project-git" data-active={panel === 'git'} aria-label={t('project.git')}>
        {!status ? <p>{t('project.loading')}</p> : !status.available ? <p>{status.reason}</p> : <>
          <h3>{t('project.branch')}: {status.branch ?? t('project.detached')}</h3><small>{status.head} · {status.upstream ?? t('project.noUpstream')} · ↑{status.ahead} ↓{status.behind}</small>
          {w.operation && <div role="status" className="project-operation">{t(`project.operation.${w.operation.status}`)} {w.operation.id}{w.operation.error && <p>{w.operation.error}</p>}{w.operation.status === 'uncertain' && <><p>{t('project.uncertain')}</p><button disabled={w.busy} onClick={() => void w.reconcile()}>{t('project.reconcile')}</button>{w.operation.evidence != null && <details open><summary>{t('project.evidence')}</summary><pre>{JSON.stringify(w.operation.evidence, null, 2)}</pre></details>}</>}</div>}
          {cleanupRequired && <section>{status.progress && <h3>{status.progress.kind}</h3>}<p>{t('project.external')}</p></section>}
          {group('project.conflicts', entries.filter(e => e.conflicted), 'unstaged')}{group('project.staged', staged, 'staged')}{group('project.unstaged', unstaged, 'unstaged')}{group('project.untracked', entries.filter(e => e.untracked), 'unstaged')}
          {!entries.length && <p>{t('project.noChanges')}</p>}
          {status.blocked && <p role="alert">{status.blocked}</p>}{!!status.hiddenChanges && <p>{t('project.hiddenChanges')} ({status.hiddenChanges})</p>}{status.protectedIndex && <p>{t('project.protectedIndex')}</p>}
          <p>{t('project.preview')}</p><textarea aria-label={t('project.message')} placeholder={t('project.message')} value={message} onChange={event => setMessage(event.target.value)} /><button disabled={gitLocked || status.protectedIndex || w.dirty || !staged.length || !message.trim() || !!status.progress || entries.some(e => e.conflicted)} onClick={() => void w.run('commit', { message })}>{t('project.commit')}</button>
          <details><summary>{t('project.branch')}</summary><input aria-label={t('project.branchName')} value={branch} onChange={event => setBranch(event.target.value)} /><button disabled={gitLocked || !branch.trim() || !!status.progress || !status.head} onClick={() => void w.run('create-branch', { name: branch })}>{t('project.createBranch')}</button><select aria-label={t('project.switchBranch')} defaultValue="" disabled={gitLocked || !clean} onChange={event => { if (event.target.value) void w.run('switch-branch', { name: event.target.value }); event.target.value = ''; }}><option value="">{t('project.switchBranch')}</option>{w.branches.map(b => <option key={b.name} value={b.name} disabled={b.current}>{b.name}</option>)}</select>{!clean && <small>{t('project.cleanRequired')}</small>}</details>
          <label>{t('project.remote')}<select value={remote || status.remotes?.[0] || ''} onChange={event => setRemote(event.target.value)}>{status.remotes?.map(r => <option key={r}>{r}</option>)}</select></label><div className="project-actions"><button disabled={gitLocked || !status.remotes?.length || !!status.progress} onClick={() => void w.run('fetch', { remote: remote || status.remotes[0] })}>{t('project.fetch')}</button><button disabled={gitLocked || !clean || !status.branch || !status.upstream} onClick={() => void w.run('pull', { confirmed: true })}>{t('project.pull')}</button><button disabled={gitLocked || w.dirty || !status.branch || !status.upstream || !!status.progress} onClick={() => setConfirmation('push')}>{t('project.push')}</button></div><small>{t('project.auth')}</small>
          <p>{t('project.pullPolicy')}</p>
          <h3>{t('project.history')}</h3>{!w.history.length && <p>{t('project.noHistory')}</p>}<ul className="project-history">{w.history.map(commit => <li key={commit.hash}><button onClick={() => void navigate(() => w.openDetail(commit.hash))}>{commit.hash.slice(0, 8)} {commit.message}</button><small>{commit.author} · {new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(commit.date))}</small></li>)}</ul>{w.historyCursor && <button onClick={() => void w.loadHistory(w.historyCursor!)}>{t('project.more')}</button>}
          {w.detail && <section className="project-commit"><h3>{w.detail.message}</h3><p>{w.detail.hash}</p><small>{w.detail.author} · {w.detail.date}</small><p>{t('project.base')}: {w.detail.base}</p>{w.detail.files?.map(file => <div key={file.path}><span>{file.status} {file.path}</span><button onClick={() => void navigate(async () => { await w.showDiff(file.path, 'commit', w.detail!.hash); setPanel('file'); })}>{t('project.base')}</button><button onClick={() => void navigate(async () => { await w.showHistorical(w.detail!.hash, file.path); setPanel('file'); })}>{t('project.historical')}</button></div>)}</section>}
        </>}
      </aside>
    </div>
    {leave && <div className="project-modal" style={{ zIndex: 110 }}><section role="dialog" aria-modal="true" aria-label={t('project.leave')}><h3>{t('project.leave')}</h3><button disabled={w.busy} onClick={() => void w.save().then(ok => { if (ok) resolveLeave(true); else resolveLeave(false); })}>{t('project.saveLeave')}</button><button disabled={w.busy} onClick={() => { if (w.discard()) resolveLeave(true); }}>{t('project.discard')}</button><button disabled={w.busy} onClick={() => resolveLeave(false)}>{t('project.cancel')}</button></section></div>}
    {management && <div className="project-modal"><section role="dialog" aria-modal="true" aria-label={t(management === 'file' ? 'project.newFile' : management === 'directory' ? 'project.newFolder' : management === 'move' ? 'project.move' : 'project.delete')}><h3>{t(management === 'file' ? 'project.newFile' : management === 'directory' ? 'project.newFolder' : management === 'move' ? 'project.move' : 'project.delete')}</h3>{management === 'delete' ? <><p>{t('project.deleteWarning')}</p><code>{w.file?.path}</code><pre>{JSON.stringify(entries.find(e => e.path === w.file?.path) ?? {}, null, 2)}</pre>{w.dirty && <strong>{t('project.dirty')}</strong>}</> : <input aria-label={t('project.path')} value={path} onChange={event => setPath(event.target.value)} />}<button disabled={locked || (management !== 'delete' && !path.trim())} onClick={() => void submitManagement()}>{t('project.confirm')}</button><button disabled={w.busy} onClick={() => setManagement(null)}>{t('project.cancel')}</button></section></div>}
    {confirmation && <div className="project-modal"><section role="dialog" aria-modal="true" aria-label={t('project.push')}><p>{t('project.pushWarning')}</p><p>{status?.remote} · {status?.branch} → {status?.upstream}</p>{status?.destinations?.map(destination => <p key={destination}>{destination}</p>)}{status?.outgoing?.map(c => <p key={c.hash}>{c.hash} {c.message}</p>)}{!status?.outgoing?.length && <p>{t('project.noOutgoing')}</p>}<button disabled={gitLocked} onClick={() => { void w.run(confirmation, { confirmed: true }); setConfirmation(null); }}>{t('project.confirm')}</button><button onClick={() => setConfirmation(null)}>{t('project.cancel')}</button></section></div>}
  </section>;
}

// Render raw source without formatters. React escapes every token, including HTML.
function ProjectSource({ content }: { content: string }) {
  const parts = content.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|import|export|class|if|else|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/g);
  return <div className="project-source" data-testid="project-source"><pre className="project-line-numbers" aria-hidden="true">{content.split('\n').map((_, i) => i + 1).join('\n')}</pre><pre><code>{parts.map((part, index) => <span key={index} className={index % 2 ? /^['"]/.test(part) ? 'project-token-string' : /^\d/.test(part) ? 'project-token-number' : 'project-token-keyword' : undefined}>{part}</span>)}</code></pre></div>;
}
