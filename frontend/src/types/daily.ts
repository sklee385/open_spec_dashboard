export type DailyState = 'running' | 'waiting' | 'error' | 'check' | 'completed' | 'idle';
export interface DailyWork {
  workId:string;sourceId:string;changeName:string;title:string;activityCount:number;turnCount:number;
  firstDayActivity:string|null;lastDayActivity:string|null;lastActivity:string|null;waitingSince:string|null;
  explicitlyCompleted:boolean;carryover:boolean;unresolvedTimeUnknown:boolean;
  current:{state:DailyState;runtime:'active'|'unknown'|'inactive';phase:string;storedState:string;checkedAt:string};
}
export interface DailyOverview {
  date:string;zone:string;checkedAt:string;bucket:string;page:number;limit:number;total:number;hasMore:boolean;items:DailyWork[];
  summary:{activeWorks:number;explicitlyCompleted:number;currentRunning:number;currentWaiting:number;currentErrors:number;currentCheck:number;carryover:number};
}
export interface DailyEvent {seq:number;type:string;createdAt:string|null;turnId:string|null;status:string|null;excerpt:string|null}
export interface DailyHistory {workId:string;scope:string;events:DailyEvent[];nextBefore:number|null}
