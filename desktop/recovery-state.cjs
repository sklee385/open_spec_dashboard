const fs = require('node:fs');
const { join } = require('node:path');
function readJson(path, fallback, limit = 128 * 1024) {
  try { if (fs.statSync(path).size > limit) return fallback; return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? undefined : fallback; }
}
function atomicJson(path, value) { const temporary = `${path}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, path); }
class RecoveryState {
  constructor(directory) {
    this.directory = directory; this.path = join(directory, 'recovery-state.json');
    const saved = readJson(this.path, { unclean: true, safeMode: true }, 8192);
    const valid = saved && typeof saved === 'object' && typeof saved.unclean === 'boolean' && typeof saved.safeMode === 'boolean';
    this.safeStartup = saved !== undefined && (!valid || saved.unclean || saved.safeMode);
    this.safeMode = this.safeStartup;
  }
  write(unclean) { fs.mkdirSync(this.directory, { recursive: true }); atomicJson(this.path, { schema: 1, unclean, safeMode: this.safeMode, at: new Date().toISOString() }); }
  started() { this.write(true); }
  setSafeMode(enabled) { this.safeMode = enabled === true; this.write(true); }
  stopped() { this.write(false); }
}
class HealthJournal {
  constructor(directory) {
    this.directory = join(directory, 'logs'); this.path = join(this.directory, 'recovery-events.json');
    const saved = readJson(this.path, []);
    this.events = (Array.isArray(saved) ? saved : []).map(event => this.clean(event)).filter(Boolean).slice(-120);
  }
  clean(event) {
    if (!event || !/^[a-z][a-z0-9-]{0,49}$/.test(event.type) || !Number.isFinite(Date.parse(event.at))) return null;
    const row = { at: event.at, type: event.type };
    for (const key of ['code', 'workId', 'state']) if (typeof event[key] === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(event[key])) row[key] = event[key];
    return row;
  }
  record(type, details = {}) {
    const event = this.clean({ ...details, type, at: new Date().toISOString() });
    if (!event) return;
    this.events.push(event); this.events = this.events.slice(-120);
    fs.mkdirSync(this.directory, { recursive: true }); atomicJson(this.path, this.events);
  }
  list() { return this.events.map(event => ({ ...event })); }
}
module.exports = { RecoveryState, HealthJournal };
