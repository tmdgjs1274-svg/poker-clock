# 포커 클락 - Render 중계 서버 (구글시트 DB 유지)

기존 구조를 그대로 유지하면서, **Google Apps Script 백엔드(doGet/doPost, `/exec` URL)만
Render에서 돌아가는 웹 서버로 교체**합니다. DB는 지금처럼 계속 Google Sheets를 씁니다.

- `index.html`은 거의 그대로 둡니다. "구글시트 DB 연결" 모달에 넣는 **URL만
  Apps Script `/exec` 주소 → Render `/exec` 주소로 바꾸면** 됩니다.
- 비밀번호 입력 방식도 그대로입니다 (Render 쪽 `APP_PASSWORD` 환경변수와 동일한 값을 입력).
- Render 무료 웹서비스는 15분 미사용 시 슬립되고, 재시작 때 로컬 파일이 초기화되지만
  이 서버는 로컬에 아무것도 저장하지 않고 **매 요청마다 구글시트를 읽고 씁니다** —
  그래서 무료 플랜으로도 데이터가 안전합니다. (첫 요청이 슬립 후라면 깨어나는 데
  ~1분 정도 걸릴 수 있습니다.)

> ✅ 실제 보내주신 `index.html`의 `dbFetchGet`/`dbFetchPost` 및 DB 모달 코드를 직접
> 읽고 맞춘 계약입니다 (추정 아님, 로컬에서 목(mock) 서버로 6가지 action 전부
> 응답 형식까지 왕복 테스트 완료). `index.html`은 한 글자도 바꾸지 않아도 됩니다 —
> "구글시트 DB 연결" 모달의 URL 필드에 Render 배포 후 나온 `.../exec` 주소만
> 새로 입력하면 그대로 연결됩니다.
>
> 계약 요약:
> - `loadLatest` (GET) → `{ ok, data?, updatedAt? }` (저장된 게 없으면 `data`/`updatedAt` 생략)
> - `saveLatest` (POST, `{data}`) → `{ ok, updatedAt }`
> - `listBackups` (GET) → `{ ok, backups:[{id,name,savedAt}, ...] }`
> - `loadBackup` (GET, `{id}`) → `{ ok, data, name, savedAt }`
> - `saveBackup` (POST, `{name,data}`) → `{ ok, id, savedAt }`
> - `deleteBackup` (POST, `{id}`) → `{ ok }`
> - 실패 시 공통으로 `{ ok:false, error:'...' }`

## 1. 준비물

1. **Google Cloud 프로젝트** (없으면 새로 하나 생성)
2. 해당 프로젝트에서 **Google Sheets API** 활성화
3. **서비스 계정(Service Account)** 생성 → JSON 키 발급 (다운로드한 JSON 파일)
4. 기존에 쓰던 **Google 시트**를 열어서, 그 서비스 계정 이메일
   (`xxx@xxx.iam.gserviceaccount.com` 형태)을 **편집자로 공유**
5. 그 시트 안에 탭 2개를 만들어 둡니다 (이름 정확히 일치해야 함):
   - `Latest` — 최신 상태 저장용
   - `Backups` — 백업 목록 저장용
   (이 서버는 각 탭의 A1 셀에 JSON 한 덩어리를 저장하는 방식이라, 탭만 만들어두면 되고
   컬럼을 미리 만들 필요는 없습니다.)

## 2. 로컬에서 테스트

```bash
cd poker-clock-render-proxy
npm install
export APP_PASSWORD="원하는_비밀번호"
export SHEET_ID="구글시트_URL의_/d/와_/edit_사이_긴_문자열"
export GOOGLE_SERVICE_ACCOUNT_KEY_BASE64="$(base64 -w0 서비스계정키.json)"
npm start
# http://localhost:3000/exec?action=loadLatest&password=원하는_비밀번호 로 확인
```

## 3. Render 배포

1. 이 폴더를 GitHub 저장소로 올립니다 (Render는 Git 저장소 기준으로 배포).
2. Render 대시보드 → **New → Blueprint** → 방금 올린 저장소 선택
   (저장소에 있는 `render.yaml`을 그대로 인식합니다).
3. 배포 화면에서 아래 3개 환경변수 값을 입력:
   - `APP_PASSWORD`: 원하는 비밀번호
   - `SHEET_ID`: 구글시트 URL의 `/d/`와 `/edit` 사이 긴 문자열
   - `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64`: 서비스 계정 JSON 키 파일 전체를
     base64로 인코딩한 값 (`base64 -w0 파일.json` 명령 결과를 그대로 붙여넣기)
4. 배포가 끝나면 `https://poker-clock-render-proxy-xxxx.onrender.com` 같은
   주소가 생깁니다. 여기에 `/exec`를 붙인 주소
   (`https://poker-clock-render-proxy-xxxx.onrender.com/exec`)가
   `index.html`의 "구글시트 DB 연결" 모달에 넣을 새 URL입니다.

## 4. 저장 방식 / 한계

- `Latest` 탭 A1 셀에는 `{updatedAt, data}` JSON 한 덩어리를, `Backups` 탭 A1 셀에는
  `[{id, name, savedAt, data}, ...]` 배열 전체를 JSON으로 저장합니다 (셀 하나짜리
  간이 저장소 방식이라 별도 컬럼 설계가 필요 없습니다).
- 구글시트 셀 하나의 글자 수 제한(약 5만자) 때문에 백업 개수를 `server.js`의
  `MAX_BACKUPS`(기본 50개)로 제한해두었고, 넘치면 가장 오래된 백업부터 자동으로
  정리됩니다. 더 많이/적게 쌓고 싶으면 이 숫자만 바꾸면 됩니다.

## 5. 무료로만 쓰고 싶은 경우 참고

Render 무료 웹서비스 자체는 계속 무료로 유지 가능합니다 (이 프록시는 로컬 저장소가
필요 없어서 Render의 "무료는 재시작 시 파일 초기화" 제약과 무관합니다). 다만
Google Sheets API에는 자체 호출 한도가 있으니, 아주 잦은 폴링/자동 새로고침 로직이
`index.html`에 있다면 그 주기를 너무 짧게 잡지 않는 게 좋습니다.
