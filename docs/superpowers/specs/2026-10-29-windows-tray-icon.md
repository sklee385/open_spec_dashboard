# v0.1.12 Windows 트레이 아이콘 수정

기존 main의 16px 임베딩 PNG는 IDAT를 inflate할 때 `unexpected end of file`이 발생했다. 트레이 자체와 메뉴는 생성했지만 이미지가 손상돼 Windows에서 식별할 수 있는 아이콘이 없었다.

기존 OpenSpecBoard SVG 로고를 재사용하여 256px PNG와 16·20·24·32·48·64·128·256px PNG 항목을 담은 Windows ICO를 생성한다. Windows 트레이는 ICO를 읽고 실패 시 PNG를 확인하며 둘 다 빈 이미지면 조용히 트레이를 만들지 않는다. 기존 열기·상태 점검·복구·업데이트·종료 메뉴 동작은 유지한다. Windows 실행 파일에도 같은 로고를 지정한다.

생성된 리소스와 로더를 스테이징 및 설치형·무설치 ASAR에 포함한다. 생성 스크립트는 `scripts/desktop-icons.cjs <sharp 모듈 경로>`이며 기존 SVG에서 재현할 수 있다. PNG·ICO를 커밋하므로 패키징에 새 sharp 의존성은 추가하지 않는다.

회귀 검사는 PNG 디코딩, ICO 헤더·작은 배율 리소스, Windows ICO 선택·PNG 대체·빈 이미지 거절과 설치형 아이콘 경로를 확인한다. 수정 전 새 검사 2개가 실패한 뒤 리소스·구현을 추가하여 데스크톱 전체 201개를 통과했다. 실제 패키지 smoke도 nativeImage 디코딩·크기와 Tray 생존 여부를 검사한다. Windows의 항상 표시/숨겨진 아이콘 정책은 시스템 설정을 변경하지 않으며 필요하면 작업 표시줄의 숨겨진 아이콘 목록에서 찾는다.

새 버전은 v0.1.12로 배포한다. 기존 다른 OpenSpec 기획 파일과 운영 세션 서버를 유지한다. 실제 패키지 검증·독립 리뷰·원격 전체 검사·공개 파일 검증 결과를 이어 기록한다.

로컬 새 Windows 패키지에서 `desktop-smoke.cjs --copy-to-temp --security --lifecycle --personal-update`를 통과했다. 실제 Electron의 아이콘 디코딩·크기·Tray 생존, 창 닫기 후 서비스 유지·트레이 재열기 콜백·정상 종료와 백업을 확인했다. 독립 리뷰에서도 로더·리소스·Windows 패키징 경로의 중요 결함은 발견되지 않았다.
