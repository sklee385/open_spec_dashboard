const repository = 'sklee385/open_spec_dashboard';
function makeUpdatePolicy(personalUpdate = false, { portable = false } = {}) {
  return { mode: personalUpdate === true ? portable ? 'portable-github' : 'personal-github' : 'local', repository, updatesEnabled: personalUpdate === true };
}
function allowPersonalUpdates(policy, isPackaged) {
  return isPackaged === true && policy?.mode === 'personal-github' && policy.repository === repository && policy.updatesEnabled === true;
}
function allowPortableUpdates(policy, isPackaged) {
  return isPackaged === true && policy?.mode === 'portable-github' && policy.repository === repository && policy.updatesEnabled === true;
}
module.exports = { repository, makeUpdatePolicy, allowPersonalUpdates, allowPortableUpdates };
