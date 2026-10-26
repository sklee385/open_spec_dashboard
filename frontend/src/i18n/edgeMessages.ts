export const enEdgeCopy = {
  'edge.title': 'Edge connection', 'edge.loading': 'Checking Edge connection…', 'edge.error': 'Could not check the Edge connection.',
  'edge.install': 'In Edge, open edge://extensions, enable Developer mode and choose Load unpacked. Select this extension folder:',
  'edge.workHint': 'Open a new Codex work to create a connection code. In Edge, select the target tab and open the OpenSpecBoard extension.',
  'edge.legacy': 'This conversation has no Edge tool. Its history is preserved; connect Edge in a new Codex work.',
  'edge.disconnected': 'No Edge tab connected.', 'edge.connected': 'Edge tab connected',
  'edge.pair': 'Create connection code', 'edge.refresh': 'Check connection', 'edge.disconnect': 'Disconnect Edge',
  'edge.endpoint': 'Connection address', 'edge.code': 'One-time code', 'edge.expires': 'Expires at', 'edge.expired': 'The connection code expired. Create a new code.',
  'edge.codeHint': 'Paste the address and code into the Edge extension, then choose Connect current tab. The code is valid for 2 minutes.',
  'edge.scope': 'Only the tab you select is connected. Changed pages need a fresh observation; another site requires reconnection.',
};
export const koEdgeCopy = {
  'edge.title': 'Edge 연결', 'edge.loading': 'Edge 연결 확인 중…', 'edge.error': 'Edge 연결을 확인하지 못했습니다.',
  'edge.install': 'Edge에서 edge://extensions를 열고 개발자 모드를 켠 뒤 ‘압축 풀린 파일 로드’로 아래 확장 폴더를 선택하세요.',
  'edge.workHint': '새 Codex 업무에서 연결 코드를 만드세요. Edge의 대상 탭을 선택하고 OpenSpecBoard 확장을 여세요.',
  'edge.legacy': '이 대화에는 Edge 도구가 없습니다. 기존 대화는 보존되며 새 Codex 업무에서 연결할 수 있습니다.',
  'edge.disconnected': '연결된 Edge 탭이 없습니다.', 'edge.connected': 'Edge 탭 연결됨',
  'edge.pair': '연결 코드 만들기', 'edge.refresh': '연결 상태 확인', 'edge.disconnect': 'Edge 연결 해제',
  'edge.endpoint': '연결 주소', 'edge.code': '일회성 코드', 'edge.expires': '만료 시각', 'edge.expired': '연결 코드가 만료됐습니다. 새 코드를 만들어 주세요.',
  'edge.codeHint': 'Edge 확장에 주소와 코드를 붙여넣고 ‘현재 탭 연결’을 누르세요. 코드는 2분간 유효합니다.',
  'edge.scope': '사용자가 선택한 탭만 연결합니다. 화면이 바뀌면 새로 관찰하고, 다른 사이트로 이동하면 다시 연결해야 합니다.',
} satisfies Record<keyof typeof enEdgeCopy, string>;
