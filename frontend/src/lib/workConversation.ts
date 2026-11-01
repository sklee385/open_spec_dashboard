export type ConversationEntry = { seq: number; type: string; data: Record<string, unknown>; createdAt?: string | null };
export type ConversationMessage = { seq: number; lastSeq: number; role: string; text: string; createdAt: string | null; completed: boolean };
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
/** SSE replay and final item replay must not duplicate text or replace its first recorded time. */
export function workConversation(events: ConversationEntry[], toolName: string, focusSeq?: number): ConversationMessage[] {
  const unique = new Map<number,ConversationEntry>();
  for (const entry of events) if (!unique.has(entry.seq)) unique.set(entry.seq,entry);
  const messages = new Map<string,ConversationMessage>();
  for (const entry of [...unique.values()].sort((a,b)=>a.seq-b.seq)) {
    if (entry.type === 'user-message') messages.set(`user:${entry.seq}`,{seq:entry.seq,lastSeq:entry.seq,role:'user',text:String(entry.data.text ?? ''),createdAt:time(entry.createdAt),completed:true});
    else if (entry.type === 'item/agentMessage/delta' || entry.type === 'item/completed' && (entry.data.item as Record<string,unknown>)?.type === 'agentMessage') {
      const item = entry.data.item as Record<string,unknown> | undefined, itemId = entry.type === 'item/completed' ? item?.id : entry.data.itemId;
      const key = typeof entry.data.turnId === 'string' && typeof itemId === 'string' ? JSON.stringify([entry.data.turnId,itemId]) : `seq:${entry.seq}`;
      const old=messages.get(key); if (old?.completed) continue;
      messages.set(key,{seq:old?.seq ?? entry.seq,lastSeq:entry.seq,role:toolName,
        text:entry.type==='item/completed'?String(item?.text ?? ''):(old?.text ?? '')+String(entry.data.delta ?? ''),
        createdAt:old ? old.createdAt : time(entry.createdAt),completed:entry.type==='item/completed'});
    }
  }
  const all=[...messages.values()],focus=focusSeq===undefined?-1:all.findIndex(message=>message.seq<=focusSeq&&message.lastSeq>=focusSeq);
  return focus<0?all.slice(-100):all.slice(Math.max(0,focus-20),Math.max(0,focus-20)+100);
}
