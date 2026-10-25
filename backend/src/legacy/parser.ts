import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { textFile, within } from '../files';
import { documentVersion } from '../review/review-items';

export function taskStats(content: string) {
  const done = (content.match(/- \[x\]/g) || []).length;
  return { total: done + (content.match(/- \[ \]/g) || []).length, done };
}
export function directories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).filter(x => x.isDirectory() && !x.isSymbolicLink()).map(x => x.name).sort();
}
export function markdownFiles(root: string, prefix = ''): string[] {
  const path = join(root, prefix);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.isSymbolicLink()) return [];
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? markdownFiles(root, name) : entry.isFile() && entry.name.endsWith('.md') ? [name] : [];
  });
}
export function parseIdea(content: string, sourceId: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) return null;
  let meta: any;
  try { meta = parse(match[1]); } catch { return null; }
  if (!meta || typeof meta.id !== 'string' || typeof meta.createdAt !== 'string' || typeof meta.updatedAt !== 'string') return null;
  const title = /^# (.+)$/m.exec(match[2]);
  return { id: `${sourceId}/${meta.id}`, sourceId, projectId: meta.projectId ?? null,
    title: title?.[1].trim() || 'Untitled Idea', description: title ? match[2].slice(title.index! + title[0].length).trim() : match[2].trim(),
    createdAt: meta.createdAt, updatedAt: meta.updatedAt };
}
export function artifacts(proposal: boolean, design: boolean, specs: boolean, tasks: boolean) {
  return [ ['proposal', proposal, []], ['design', design, proposal ? [] : ['proposal']],
    ['specs', specs, proposal ? [] : ['proposal']], ['tasks', tasks, [...(design ? [] : ['design']), ...(specs ? [] : ['specs'])]] ]
    .map(([id, present, deps]) => ({ id, state: present ? 'complete' : (deps as string[]).length ? 'blocked' : 'ready', missingDeps: present ? [] : deps }));
}
export function changeAt(root: string, sourceId: string, name: string, archived = false) {
  const path = within(root, `changes/${archived ? 'archive/' : ''}${name}`);
  const proposal = textFile(join(path, 'proposal.md')), design = textFile(join(path, 'design.md')), raw = textFile(join(path, 'tasks.md'));
  const marker = textFile(join(path, '.openspec.yaml'));
  const hasSpecs = existsSync(join(path, 'specs'));
  const sourceIdeas = markdownFiles(join(path, 'source-ideas'));
  if (marker === null && proposal === null && design === null && raw === null && !hasSpecs && !sourceIdeas.length) return null;
  const title = sourceIdeas.map(file => parseIdea(textFile(within(root, `${path}/source-ideas/${file}`))!, sourceId)?.title).find(Boolean) || name;
  const stats = raw === null ? null : taskStats(raw);
  let schema: string | null = null;
  if (marker !== null) { try { schema = parse(marker)?.schema || 'spec-driven'; } catch { schema = 'spec-driven'; } }
  const status = archived ? 'archived' : raw === null ? 'draft' : !stats?.done ? 'todo' : stats.total === stats.done ? 'done' : 'in_progress';
  return { id: `${sourceId}/${name}`, name, title, sourceId, status, hasProposal: proposal !== null, hasDesign: design !== null,
    hasSpecs, hasTasks: raw !== null, taskStats: stats, schema, artifacts: artifacts(proposal !== null, design !== null, hasSpecs, raw !== null) };
}
export function changeDetail(root: string, sourceId: string, name: string) {
  let record = changeAt(root, sourceId, name), path = join(root, 'changes', name);
  if (!record) {
    const archived = directories(join(root, 'changes', 'archive')).find(x => x === name || x.endsWith(`-${name}`));
    if (archived) { record = changeAt(root, sourceId, archived, true); path = join(root, 'changes', 'archive', archived); }
  }
  if (!record) return null;
  const raw = textFile(join(path, 'tasks.md'));
  const proposal = textFile(join(path, 'proposal.md')), design = textFile(join(path, 'design.md'));
  const specs = markdownFiles(join(path, 'specs')).map(file => ({ path: file, content: textFile(within(root, `${path}/specs/${file}`))! }));
  return { id: `${sourceId}/${name}`, name: record.name, title: record.title, sourceId, status: record.status, proposal,
    design, specs, tasks: raw === null ? null : { raw, stats: taskStats(raw) },
    documentVersions: Object.fromEntries([
      ['proposal.md', proposal], ['design.md', design], ['tasks.md', raw],
      ...specs.map(spec => [`specs/${spec.path}`, spec.content]),
    ].filter((entry): entry is [string, string] => entry[1] !== null).map(([file, content]) => [file, documentVersion(content)])),
    schema: record.schema, artifacts: artifacts(record.hasProposal, record.hasDesign, specs.length > 0, record.hasTasks) };
}
