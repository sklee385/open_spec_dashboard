const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');
test('개인용 CI는 기본 GitHub 토큰만 사용하며 인증서 없이 명시적 개인용 패키지를 생성한다', () => {
  const workflow = parse(fs.readFileSync(path.join(__dirname, '../../.github/workflows/desktop.yml'), 'utf8'));
  const build = workflow.jobs.build;
  assert.equal(build['runs-on'], 'windows-latest');
  assert.equal(build.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(Object.keys(build.env).some(key => key.startsWith('CSC_')), false);
  assert.equal(JSON.stringify(workflow).includes('WIN_CSC'), false);
  const stage = build.steps.find(step => step.name === 'Stage application').run;
  assert.match(stage, /desktop-stage\.cjs --release/); assert.match(stage, /desktop-stage\.cjs --personal-update/);
  assert.equal(workflow.jobs.release.permissions.contents, 'write');
  assert.equal(workflow.jobs.release.steps.at(-1).env.GH_TOKEN, '${{ github.token }}');
  assert.equal(workflow.jobs.release.steps.at(-1).run, 'node desktop/publish.cjs release-files');
});
