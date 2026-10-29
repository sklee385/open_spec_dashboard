import { useRef, useState } from 'react';

type Connection = { available: boolean; connectionPath: string; cliPath: string; nodePath: string; transport: string; mobileVerified: boolean };
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function RemoteBoardConnection({ workId }: { workId: string }) {
  const [connection, setConnection] = useState<Connection>(), [error, setError] = useState('');
  const loading = useRef(false);
  const load = async () => {
    if (loading.current || connection) return;
    loading.current = true; setError('');
    try {
      const response = await fetch('/api/remote');
      if (!response.ok) throw new Error();
      const info = await response.json() as Connection;
      if (!info.available || !info.connectionPath || !info.cliPath || !info.nodePath) throw new Error();
      setConnection(info);
    } catch { setError('연결 정보를 확인하지 못했습니다. Board 실행 상태를 확인해 주세요.'); }
    finally { loading.current = false; }
  };
  const instruction = connection ? `이 PC의 OpenSpecBoard 업무를 조작합니다. 먼저 PowerShell에서 다음 읽기 전용 명령으로 상태를 확인해 주세요.\n& ${quote(connection.nodePath)} ${quote(connection.cliPath)} --connection ${quote(connection.connectionPath)} status ${quote(workId)}\n연결 파일에는 인증 정보가 있으므로 내용을 대화에 출력하지 마세요. 이후 변경·답변·승인·중단은 제가 지시한 동작만 실행하고 CLI의 --help로 인자를 확인하세요. Board 실행과 동시에 같은 파일을 직접 수정하지 마세요.` : '';
  return <details className="work-remote-connection" onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary>모바일 Codex 연결</summary>
    <p>PC의 Codex 원격 연결을 설정한 뒤, 모바일 Codex에서 이 PC의 업무를 열고 아래 안내를 전달하세요. PC와 Board가 켜져 있어야 합니다.</p>
    {error && <p role="alert">{error}<button onClick={() => void load()}>연결 정보 다시 확인</button></p>}
    {connection && <>
      <label>Codex에 전달할 연결 안내<textarea aria-label="Codex에 전달할 연결 안내" readOnly value={instruction} rows={7} /></label>
      <p>연결 파일의 인증 정보는 표시하지 않습니다. Board의 기존 검토·승인 절차가 적용됩니다.</p>
      {!connection.mobileVerified && <p>모바일 실제 연결은 아직 검증하지 않았습니다. 아래 명령의 성공 여부를 모바일에서 확인해야 합니다.</p>}
    </>}
  </details>;
}
