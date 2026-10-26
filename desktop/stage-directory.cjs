const fs = require('node:fs');
const path = require('node:path');
function validateStageName(name) {
  if (typeof name !== 'string' || !/^desktop-stage(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(name)) throw new Error('허용되지 않은 빌드 경로 이름입니다');
  return name;
}
function prepareStageDirectory(root, name = 'desktop-stage') {
  validateStageName(name);
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const tools = path.join(resolvedRoot, '.tools');
  const stage = path.join(tools, name);
  for (const directory of [tools, stage]) {
    if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('링크 빌드 경로는 사용할 수 없습니다');
  }
  if (path.relative(resolvedRoot, stage) !== path.join('.tools', name)) throw new Error('빌드 경로가 잘못되었습니다');
  fs.mkdirSync(tools, { recursive: true });
  // The target is the verified fixed disposable directory inside this root.
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage);
  return stage;
}
module.exports = { prepareStageDirectory, validateStageName };
