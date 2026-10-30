import { BadRequestException } from '@nestjs/common';
import type { WorkStore } from './store';
import type { WorkspaceSettings } from './workspace-settings.service';
import { inspectCapacity } from './workspace-capacity';
import { localRuntimeDirectory } from '../runtime';
import { browserDirectory } from '../browser/browser-runtime';
const offset = (value: unknown) => { if(value===undefined)return 0;if(typeof value!=='string'||!/^\d{1,7}$/.test(value))throw new BadRequestException('조회 위치를 확인해 주세요');return Number(value); };
/** Explicit bounded metadata/capacity read. Never opens original source files or expires evidence. */
export function workspaceMaintenance(store: WorkStore, settings: WorkspaceSettings, query: Record<string,unknown>) {
  if(Object.keys(query).some(key=>!['spaceAfter','imageAfter'].includes(key)))throw new BadRequestException('정리 목록 조회 범위를 확인해 주세요');
  const spaceAfter=offset(query.spaceAfter),imageAfter=offset(query.imageAfter),limit=25;
  const spaces=store.db.prepare(`SELECT * FROM (
    SELECT w.id workId,w.change_name changeName,json_extract(w.data,'$.phase') phase,'work' targetKind,NULL candidateId,json_extract(w.data,'$.workspace.workspaceId') workspaceId,
      coalesce(json_extract(w.data,'$.workspace.kind'),'copy') kind,json_extract(w.data,'$.workspace.rootId') rootId,json_extract(w.data,'$.executionPath') path,coalesce(json_extract(w.data,'$.workspace.status'),'legacy') spaceStatus
      FROM work w WHERE json_type(w.data,'$.executionPath')='text'
    UNION ALL
    SELECT r.work_id workId,w.change_name changeName,json_extract(w.data,'$.phase') phase,'integration-candidate' targetKind,json_extract(r.data,'$.candidateId') candidateId,json_extract(r.data,'$.candidateId') workspaceId,
      'git-worktree' kind,json_extract(r.data,'$.rootId') rootId,json_extract(r.data,'$.executionPath') path,
      coalesce((SELECT json_extract(c.data,'$.status') FROM records c WHERE c.work_id=r.work_id AND c.kind='workspace-cleanup' AND json_extract(c.data,'$.candidateId')=json_extract(r.data,'$.candidateId') ORDER BY c.rowid DESC LIMIT 1),json_extract(r.data,'$.status')) spaceStatus
      FROM records r JOIN work w ON w.id=r.work_id WHERE r.kind='integration-request' AND json_type(r.data,'$.executionPath')='text'
    ) ORDER BY workId,targetKind,candidateId LIMIT ? OFFSET ?`).all(limit+1,spaceAfter) as any[];
  const hasCaptures=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='completion_captures'").get();
  const images=hasCaptures?store.db.prepare(`SELECT c.work_id workId,i.capture_id captureId,i.id,i.sha256,i.created_at createdAt,i.expired_at expiredAt,length(i.bytes) bytes FROM completion_images i JOIN completion_captures c ON c.id=i.capture_id ORDER BY i.rowid LIMIT ? OFFSET ?`).all(limit+1,imageAfter) as any[]:[];
  const runtime=localRuntimeDirectory(),sharedPaths=[runtime,browserDirectory()].filter((path):path is string=>typeof path==='string');
  const capacities=inspectCapacity(settings.roots,{sharedPaths});
  if(!runtime){capacities.shared.bytes=null;capacities.shared.status='partial';capacities.shared.errors.push('Node 런타임 경로가 미확인입니다');capacities.status='partial';}
  return {version:settings.version,retentionDays:settings.policy.retentionDays,measuredAt:new Date().toISOString(),roots:settings.roots.map(root=>({...root,selected:root.rootId===settings.selectedRootId,capacity:capacities.roots.find(row=>row.rootId===root.rootId)})),shared:capacities.shared,totalBytes:capacities.bytes,capacityStatus:capacities.status,
    spaces:spaces.slice(0,limit).map(row=>{const root=capacities.roots.find(root=>root.rootId===row.rootId),usage=(row.targetKind==='work'?root?.works:root?.candidates)?.find(item=>item.workspaceId===row.workspaceId);return {...row,bytes:usage?.bytes??null,capacityStatus:root?.status??'partial'};}),nextSpaceAfter:spaces.length>limit?spaceAfter+limit:null,
    images:images.slice(0,limit).map(row=>({...row,state:row.expiredAt?'expired':row.sha256&&row.bytes!==null?'available':'missing',eligibleForCleanup:!row.expiredAt&&!!row.sha256&&row.bytes!==null&&Date.now()>=Date.parse(row.createdAt)+settings.policy.retentionDays*86400000})),nextImageAfter:images.length>limit?imageAfter+limit:null};
}
