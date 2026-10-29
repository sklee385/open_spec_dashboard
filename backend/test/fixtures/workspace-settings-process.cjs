const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { LegacyService } = require('../../src/legacy/legacy.service.ts');
const { WorkspaceSettingsService } = require('../../src/work/workspace-settings.service.ts');
const legacy = new LegacyService(), settings = new WorkspaceSettingsService(legacy);
process.on('message', async message => {
  try {
    if (message.action === 'stop') { await legacy.onModuleDestroy(); process.disconnect(); return; }
    if (message.action === 'crash-with-lock') { legacy.updateConfig(() => { process.exit(21); }); return; }
    if (message.action === 'select') {
      const current = settings.read();
      // This trusted fixture seeds registered roots; it never creates an actual workspace.
      settings.update(current.version, draft => {
        const root = { rootId: randomUUID(), path: message.path, managedPath: join(message.path, `openspecboard-${draft.profileId}`), confirmedAt: new Date().toISOString() };
        draft.roots.push(root); draft.selectedRootId = root.rootId;
      });
    }
    const { path, source, version, profileId } = settings.view();
    process.send({ path, source, version, profileId });
  } catch (error) { process.send({ error: error.message }); }
});
