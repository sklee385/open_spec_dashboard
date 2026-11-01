// Read-only projections: stream fragments and transport notifications are not
// separate meaningful activities. An AI turn finishing is not a work completion.
export function dailyEventIdentity(alias: string) {
  return `CASE WHEN ${alias}.type='item/completed' AND json_extract(${alias}.data,'$.turnId') IS NOT NULL AND json_extract(${alias}.data,'$.item.id') IS NOT NULL
    THEN 'item:'||json_extract(${alias}.data,'$.turnId')||':'||json_extract(${alias}.data,'$.item.id')
    WHEN ${alias}.type IN ('turn/started','turn/completed') AND COALESCE(json_extract(${alias}.data,'$.turn.id'),json_extract(${alias}.data,'$.turnId')) IS NOT NULL
    THEN ${alias}.type||':'||COALESCE(json_extract(${alias}.data,'$.turn.id'),json_extract(${alias}.data,'$.turnId')) ELSE NULL END`;
}
export function dailyEventFilter(alias = 'e') {
  const identity = dailyEventIdentity(alias);
  return `(${alias}.type IN ('created','source-idea','user-message','message-queued','document-saved','reviewed','workspace-isolated','changes-applied','completed','archive-result','verification','turn/started','turn/completed','answer','approval','answer-recovered','recovery-failed','session-recovered','codex-processing-error')
    OR (${alias}.type='item/completed' AND json_extract(${alias}.data,'$.item.type')='agentMessage'))
    AND (${identity} IS NULL OR NOT EXISTS(SELECT 1 FROM events duplicate WHERE duplicate.work_id=${alias}.work_id AND duplicate.type=${alias}.type AND duplicate.seq<${alias}.seq AND ${dailyEventIdentity('duplicate')}=${identity}))`;
}
