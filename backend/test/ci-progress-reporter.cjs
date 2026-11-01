'use strict';

// Metadata only: keep the existing reporter, assertions, timeouts and exit status.
// In a long file, a missing summary must not hide which hook/test last started.
module.exports = class CiProgressReporter {
  emit(event, metadata) { process.stdout.write(`[backend-progress] ${JSON.stringify({ at: new Date().toISOString(), event, ...metadata })}\n`); }
  onTestRunStart(specifications) { this.emit('run-start', { files: specifications.length }); }
  onTestModuleQueued(module) { this.emit('file-queued', { file: module.relativeModuleId }); }
  onTestModuleCollected(module) { this.emit('file-collected', { file: module.relativeModuleId }); }
  onTestModuleStart(module) { this.emit('file-start', { file: module.relativeModuleId }); }
  onTestCaseReady(test) { this.emit('test-start', { file: test.module.relativeModuleId, test: test.fullName }); }
  onTestCaseResult(test) { this.emit('test-end', { file: test.module.relativeModuleId, test: test.fullName, state: test.result().state }); }
  onTestModuleEnd(module) { this.emit('file-end', { file: module.relativeModuleId }); }
  onTestRunEnd(_modules, errors, reason) { this.emit('run-end', { reason, unhandledErrors: errors.length }); }
};
