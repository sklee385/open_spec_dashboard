'use strict';
// Loaded from the host's absolute path before the waiting worker's main module.
// This channel only proves the directly created process identity; it starts no work.
process.on('message', message => {
  if (message && message.protocol === 'openspec-handle-v1' && message.type === 'challenge' && typeof message.nonce === 'string' && /^[a-f0-9]{64}$/.test(message.nonce) && process.connected) {
    process.send({ protocol: 'openspec-handle-v1', type: 'response', nonce: message.nonce, pid: process.pid });
  }
});
