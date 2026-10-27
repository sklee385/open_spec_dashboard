const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function configureGraphics(app, userDirectory, platform = process.platform) {
  let settings;
  try { settings = JSON.parse(readFileSync(join(userDirectory, 'graphics.json'), 'utf8')); }
  catch { /* Missing or damaged preferences use the platform default. */ }
  const enabled = typeof settings?.hardwareAcceleration === 'boolean' ? settings.hardwareAcceleration : platform !== 'win32';
  if (!enabled) app.commandLine.appendSwitch('disable-gpu');
  return { hardwareAcceleration: enabled };
}

module.exports = { configureGraphics };
