# 0.1.20 공개 배포 및 지정 무설치 앱 업데이트 결과

- 배포 commit: `fb68b3257f7123339d03ece4a3860d45f7deb133`, tag `v0.1.20`.
- 정식 릴리스: https://github.com/sklee385/open_spec_dashboard/releases/tag/v0.1.20
- CI: https://github.com/sklee385/open_spec_dashboard/actions/runs/41263117770 — build/release 모두 success.
- 변경 직접 영향 backend 32개(14+7+11), frontend 17개, 게시 검사 10개 통과. 전체 suite는 실행하지 않았다. 선택되지 않은 기존 테스트는 삭제하거나 성공 처리하지 않았다.
- backend/frontend build, 실제 Electron 화면 복구·세션 보존, 강제 종료·서비스 종료·SQLite 무결성·안전 재시작·초안 복구, 실제 ASAR 압축 해제·독립 helper·폴더 교체·기존 앱 백업·새 버전 시작·정상 종료 smoke 통과.
- 공개 산출물 5개의 이름·크기·업로드 상태·SHA256 metadata를 확인했다. CI publisher는 5개 실물 검증 후 게시했고, 로컬에는 portable ZIP과 manifest만 내려받아 SHA256·SHA512·크기·버전을 대조했다.

## 실제 대상

`D:/sklee/2.work/phpstorm/0.etc_work/open_spec_dashboard/.tools/OpenSpecBoard/OpenSpecBoard.exe`만 `0.1.3 → 0.1.20`으로 교체했다. 바탕화면 `OpenSpecBoard (자동 업데이트).lnk`는 이 경로를 가리키고 추가 인자는 없다. 별도 설치본은 업데이트하지 않았다. 13003 세션 서버도 재시작하지 않았다.

교체 전 실제 지정 프로세스가 없음을 확인했고, 기존 대상의 데이터 소유 잠금 아래 전체 백업과 현재 application/profile의 파일 해시 일치를 다시 확인했다. 공식 ZIP을 준비한 뒤 독립 helper가 기존 앱 폴더를 백업하고 새 앱을 정상 시작했다. journal `complete`, 정확한 버전/PID의 ready marker, 기존 앱 폴더 백업 존재를 확인했다. 최종 지정 앱의 주 프로세스는 1개, 다른 OpenSpecBoard 프로세스는 0개였다.

Windows 앱 접근성에서 실제 지정 창의 업무·프로젝트·설정 정적 UI를 확인했다. 개인 업무 제목이나 화면 이미지는 기록하지 않았다. 이는 native 창 확인이며 브라우저 검증으로 보고하지 않는다.

## 데이터 보존

동일 사용자 프로필의 DB를 읽기 전용 트랜잭션으로 대조했다. 기존 작업 20개·records 173개는 누락/내용 변경 0개, 기존 events 310,649개의 순서 및 내용 hash도 일치했다. 설정 파일 hash 일치, 원래 초안은 0개였으며 없는 초안을 복구했다고 보고하지 않는다. 실제 사용 원본 기록은 수정하지 않았다.

전체 application/profile의 짝 백업과 교체 시 기존 앱 폴더를 모두 유지했다. 필요 시 지정 앱을 정상 종료하고 소유 잠금을 확보한 뒤 application/profile 한 쌍을 복원한다. 실행 중인 DB만 덮어쓰지 않는다. 개인 파일 경로 목록과 원문 hash별 상세 manifest는 ignored `.tools`에만 보관한다.

## 범위와 후속

실제 설치본 시나리오 전체를 검증한 것은 아니므로 tasks 9.3 전체를 완료로 바꾸지 않는다. 앞으로의 모든 오류가 없다고 보장하지 않는다. 후속 승인된 읽기 전용 일일 현황판은 이 릴리스에 포함하지 않았으며, 배포 완료 후 별도 작업 공간에서 순차 개발한다.
