const repository = 'sklee385/open_spec_dashboard';
function makeUpdatePolicy(personalUpdate = false) {
  return { mode: personalUpdate === true ? 'personal-github' : 'local', repository, updatesEnabled: personalUpdate === true };
}
function allowPersonalUpdates(policy, isPackaged) {
  return isPackaged === true && policy?.mode === 'personal-github' && policy.repository === repository && policy.updatesEnabled === true;
}
module.exports = { repository, makeUpdatePolicy, allowPersonalUpdates };
