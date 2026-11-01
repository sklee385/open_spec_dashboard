import { expect, it } from 'vitest';
import { workConversation } from './workConversation';
it('stream·완료·재연결 replay를 합치고 첫 시각과 원문 seq를 보존한다',()=>{
  const delta={seq:2,type:'item/agentMessage/delta',createdAt:'2026-11-01T01:00:00Z',data:{turnId:'t',itemId:'m',delta:'안녕'}};
  const completed={seq:3,type:'item/completed',createdAt:'2026-11-01T01:00:01Z',data:{turnId:'t',item:{id:'m',type:'agentMessage',text:'안녕하세요'}}};
  const result=workConversation([delta,delta,completed,{...completed,seq:4,createdAt:'2026-11-02T00:00:00Z'}],'Codex');
  expect(result).toEqual([{seq:2,lastSeq:3,role:'Codex',text:'안녕하세요',createdAt:delta.createdAt,completed:true}]);
});
it('같은 사용자 문장은 별도 메시지이며 시각이 없으면 새 시각을 만들어 넣지 않는다',()=>{
  const result=workConversation([{seq:1,type:'user-message',data:{text:'계속'}},{seq:2,type:'user-message',createdAt:'bad',data:{text:'계속'}},{seq:3,type:'item/agentMessage/delta',data:{turnId:'t',itemId:'m',delta:'답'}},{seq:4,type:'item/completed',createdAt:'2026-11-01T00:00:00Z',data:{turnId:'t',item:{id:'m',type:'agentMessage',text:'답변'}}}],'AI');
  expect(result).toHaveLength(3);expect(result.every(message=>message.createdAt===null)).toBe(true);
});
it('원문 이동은 최근 100개 밖의 오래된 메시지도 해당 범위로 표시한다',()=>{
  const events=Array.from({length:150},(_,index)=>({seq:index+1,type:'user-message',data:{text:String(index)}}));
  expect(workConversation(events,'AI',1)[0].seq).toBe(1);expect(workConversation(events,'AI')[0].seq).toBe(51);
});
