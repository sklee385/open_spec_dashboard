import { useI18n } from '../i18n/context';

export type TestScope = 'work' | 'full';
export type TestCommand = { id: string; command: string; args: string[] };
export type TestResult = { id: string; commandId: string; scope?: TestScope; status: string; fresh: boolean; stdout: string; stderr: string; code: number | null; durationMs?: number | null };

export function WorkTestActions({ disabled, onRun }: { disabled: boolean; onRun: (scope: TestScope) => void }) {
  const { t } = useI18n();
  return <><button disabled={disabled} title={t('tests.hint')} onClick={() => onRun('work')}>{t('tests.work')}</button><button disabled={disabled} title={t('tests.hint')} onClick={() => onRun('full')}>{t('tests.full')}</button></>;
}

export function WorkTestResults({ workCommands, fullCommands, results, onFix }: { workCommands: TestCommand[]; fullCommands: TestCommand[]; results: TestResult[]; onFix: (text: string) => void }) {
  const { t } = useI18n();
  const status = (value: string) => ({ passed: t('workRoom.passed'), failed: t('workRoom.failed'), running: t('workRoom.running'), interrupted: t('workRoom.interrupted'), stale: t('tests.stale'), waiting: t('tests.waiting') })[value] || value;
  const latest = (scope: TestScope, id: string) => results.filter(row => (row.scope || 'full') === scope && row.commandId === id).at(-1);
  const state = (row?: TestResult) => !row ? 'waiting' : row.status === 'running' ? 'running' : !row.fresh ? 'stale' : row.status;
  const groupState = (scope: TestScope, commands: TestCommand[]) => {
    const states = commands.map(command => state(latest(scope, command.id)));
    return ['running', 'failed', 'interrupted', 'stale', 'waiting'].find(value => states.includes(value)) || (states.length ? 'passed' : 'waiting');
  };
  const failures = results.filter(row => row.status === 'failed' && latest(row.scope || 'full', row.commandId)?.id === row.id);
  return <section aria-label={t('workRoom.verification')}>
    <p className="work-hint">{t('tests.hint')}</p>
    {(['work', 'full'] as const).map(scope => {
      const commands = scope === 'work' ? workCommands : fullCommands;
      return <section key={scope}>
        <h2>{t(scope === 'work' ? 'tests.work' : 'tests.full')} · {status(groupState(scope, commands))}</h2>
        {!commands.length ? <p>{t(scope === 'work' ? 'tests.noWork' : 'tests.noFull')}</p> : <table><thead><tr><th>{t('tests.command')}</th><th>{t('tests.status')}</th></tr></thead><tbody>{commands.map(command => <tr key={command.id}><td><code>{command.id}</code><details><summary>{t('tests.definition')}</summary><pre>{[command.command, ...command.args].join('\n')}</pre></details></td><td>{status(state(latest(scope, command.id)))}</td></tr>)}</tbody></table>}
      </section>;
    })}
    {!!failures.length && <button onClick={() => onFix(`${t('tests.fixPrompt')}\n\n${failures.map(row => `${row.scope === 'work' ? t('tests.work') : t('tests.full')} / ${row.commandId}\n${row.stdout.slice(-6000)}\n${row.stderr.slice(-6000)}`).join('\n\n').slice(0, 20000)}`)}>{t('tests.fix')}</button>}
    {!!results.length && <h2>{t('tests.history')}</h2>}
    {results.map(row => <details key={row.id}><summary>{t(row.scope === 'work' ? 'tests.work' : 'tests.full')} · <span>{row.commandId} · {status(row.status)} · {row.fresh ? t('workRoom.currentVersion') : t('workRoom.oldResult')}</span>{typeof row.durationMs === 'number' ? ` · ${t('tests.duration', { seconds: (row.durationMs / 1000).toFixed(1) })}` : ''}</summary><pre>{row.stdout}{'\n'}{row.stderr}{'\n'}{t('workRoom.exitCode')} {String(row.code)}</pre></details>)}
  </section>;
}
