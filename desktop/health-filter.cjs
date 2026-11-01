(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.healthWorkVisibility = api;
})(globalThis, () => {
  // Missing evidence stays visible. Administrative archive is never runtime proof.
  const normal = work => work?.status === 'normal' && work.runtime === 'inactive' && work.state === 'idle' && work.hasError === false && Array.isArray(work.reasons) && work.reasons.length === 0 && work.canRecover === false && work.canInterrupt === false;
  const archivedNormal = work => (work?.phase === 'archived' || work?.managementState === 'archived') && normal(work);
  function filterWorks(works, problemsOnly = false) {
    const available = works.filter(work => !archivedNormal(work));
    const visible = problemsOnly ? available.filter(work => !normal(work)) : available;
    return { visible, hiddenArchivedCount: works.length - available.length, filteredCount: available.length - visible.length };
  }
  return { normal, archivedNormal, filterWorks };
});
