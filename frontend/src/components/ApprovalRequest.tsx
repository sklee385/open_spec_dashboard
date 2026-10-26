import { Fragment } from 'react';
import { useI18n } from '@/i18n/context';
import { CodeBlock, JsonBlock } from './WorkContent';

const fieldKeys = {
  reason: 'workContent.reason', command: 'workContent.command', cwd: 'workContent.cwd',
  permissions: 'workContent.permissions', network: 'workContent.network', fileSystem: 'workContent.filesystem',
  filesystem: 'workContent.filesystem', read: 'workContent.read', write: 'workContent.write',
  readPaths: 'workContent.read', writePaths: 'workContent.write', grantRoot: 'workContent.grantRoot',
  path: 'workContent.path', commandActions: 'workContent.actions', type: 'workContent.type',
  enabled: 'workContent.enabled', target: 'workContent.path', changes: 'workContent.changes',
} as const;
const fieldKey = (name: string) => fieldKeys[name as keyof typeof fieldKeys];

export function ApprovalRequest({ method, params }: { method: string; params: Record<string, unknown> }) {
  const { t } = useI18n();
  const valueView = (value: unknown, key = ''): React.ReactNode => {
    if (typeof value === 'boolean') return t(value ? 'workContent.allowed' : 'workContent.notAllowed');
    if (value === null || value === undefined) return t('common.none');
    if (Array.isArray(value)) return value.length ? <ul>{value.map((item, index) => <li key={index}>{valueView(item, key)}</li>)}</ul> : t('common.none');
    if (typeof value === 'object') return <dl className="work-approval-fields">{Object.entries(value).map(([name, item]) => <Fragment key={name}><dt>{fieldKey(name) ? t(fieldKey(name)) : name}</dt><dd>{valueView(item, name)}</dd></Fragment>)}</dl>;
    if (key === 'command') return <CodeBlock language="bash" text={String(value)} />;
    return String(value);
  };
  const kind = method.includes('/commandExecution/') ? 'workContent.commandRequest' : method.includes('/fileChange/') ? 'workContent.fileRequest' : method.includes('/permissions/') ? 'workContent.permissionRequest' : 'workContent.otherRequest';
  const fields = ['reason', 'command', 'cwd', 'grantRoot', 'permissions', 'commandActions', 'changes'];
  return <div className="work-approval-summary">
    <p>{t(kind)}</p>
    <dl className="work-approval-fields">{fields.filter(key => params[key] !== undefined && params[key] !== null).map(key => <Fragment key={key}><dt>{t(fieldKey(key))}</dt><dd>{valueView(params[key], key)}</dd></Fragment>)}</dl>
    <details className="work-approval-raw"><summary>{t('workContent.rawRequest')}</summary><JsonBlock value={{ method, ...params }} /></details>
  </div>;
}
