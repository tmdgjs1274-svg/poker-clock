# 포커 클락 - Render로 통째로 배포 (구글시트 DB 유지)

**Render 서비스 주소 하나로 포커 클락 화면 + 구글시트 연동이 전부 동작합니다.**
`public/index.html`(포커 클락 화면 그 자체)과 `server.js`(구글시트로 이어주는
API)를 이 서버 하나가 같이 서빙합니다.

- 배포 후 `https://<서비스이름>.onrender.com` 주소로 그냥 접속하면 바로 클락
  화면이 뜹니다. 로컬에서 `index.html`을 따로 열 필요 없습니다.
- "구글시트 DB 연결" 모달의 URL 칸도 이 서버 자기 자신(`/exec`)으로 이미
  채워져 있어서 URL을 따로 입력할 필요가 없습니다 — 비밀번호(APP_PASSWORD와
  동일한 값)만 한 번 입력하면 연결됩니다.
- Render 무료 웹서비스는 15분 미사용 시 슬립되고, 재시작 때 로컬 파일이 초기화되지만
  이 서버는 로컬에 아무것도 저장하지 않고 **매 요청마다 구글시트를 읽고 씁니다** —
  그래서 무료 플랜으로도 데이터가 안전합니다. (첫 요청이 슬립 후라면 깨어나는 데
  ~1분 정도 걸릴 수 있습니다.)
- 헬스체크(단순 생존 확인)는 `/healthz`로 옮겨뒀습니다 (`/`는 이제 클락 화면 차지).

> ✅ 실제 보내주신 `index.html`의 `dbFetchGet`/`dbFetchPost` 및 DB 모달 코드를 직접
> 읽고 맞춘 계약입니다 (추정 아님, 로컬에서 목(mock) 서버로 6가지 action 전부
> 응답 형식까지 왕복 테스트 완료). `public/index.html` 안의 URL 기본값도 이미
> `/exec`(자기 자신)로 바꿔뒀기 때문에, 배포된 주소로 접속하기만 하면 비밀번호만
> 입력해도 바로 연결됩니다.
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
5. 탭은 따로 안 만들어도 됩니다 — 이 서버가 필요한 탭(`Templates`, `Latest`,
   `Backups`, `BackupTemplates`)이 없으면 첫 저장 시 자동으로 만듭니다.

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
   - `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64`: 다운로드한 서비스 계정 JSON 키 **파일을 메모장/텍스트
     편집기로 열어서 내용 전체(중괄호 `{`부터 `}`까지)를 그대로 복사해서 붙여넣기** — 이름은
     "base64"지만 지금은 원본 JSON을 그대로 넣어도 인식하도록 만들어뒀습니다. (base64로
     인코딩해서 넣어도 여전히 동작합니다 — 어느 쪽이든 상관없어요.)
4. 배포가 끝나면 `https://poker-clock-render-proxy-xxxx.onrender.com` 같은
   주소가 생깁니다. **이 주소로 그냥 접속하면 포커 클락 화면이 바로 뜹니다.**
   "구글시트 DB 연결" 모달을 열면 URL은 이미 채워져 있고, 비밀번호(APP_PASSWORD와
   동일한 값)만 입력하면 연결됩니다.

## 4. 저장 방식 / 한계

이제 구글시트를 직접 열어봐도 표 형태로 읽힙니다 (예전처럼 셀 하나에 JSON 텍스트
덩어리가 통째로 들어가지 않습니다). 탭 4개를 이렇게 나눠 씁니다.

- **`Templates`** — `id | name | anteEnabled | structure` : 지금 앱에 있는 템플릿
  목록이 **템플릿 하나당 한 행**으로 저장됩니다. 레벨·휴식 구성만 `structure` 칸에
  JSON으로 들어가 있고(그 안까지 행으로 쪼개면 너무 잘게 나뉘어서), 어떤 템플릿이
  몇 개 있는지·이름이 뭔지는 시트에서 바로 보입니다.
- **`Latest`** — `key | value` : 템플릿 전체가 아니라 **테마·레이아웃·마지막으로
  선택했던 템플릿 id 정도의 "설정"만** 몇 줄짜리 표로 저장합니다.
- **`Backups`** — `id | name | savedAt | activeTemplateId | nextTemplateId | theme
  | layout` : "현재 버전 저장(백업)"을 누를 때마다 **백업 한 건당 한 행**이 추가됩니다.
- **`BackupTemplates`** — `backupId | id | name | anteEnabled | structure` : 각
  백업 시점의 템플릿 목록과 블라인드 구조를, `Templates`와 같은 모양으로 **백업 안의
  템플릿 하나당 한 행**씩 담아둡니다 (`backupId`로 어느 백업 소속인지 구분).

수정/삭제는 해당 탭 데이터를 통째로 다시 읽어서 자바스크립트에서 걸러낸 뒤 전체를
다시 쓰는 방식이라(특정 행만 콕 집어 지우는 것보다 훨씬 단순하고 안전합니다),
개인용 도구 규모에서는 속도상 문제가 없습니다. 백업 개수는 `server.js`의
`MAX_BACKUPS`(기본 50개)로 제한해두었고, 넘치면 가장 오래된 백업부터(그 백업의
`BackupTemplates` 행들까지) 자동으로 정리됩니다.

> ⚠️ 예전(셀 하나에 JSON 통짜로 저장하던) 버전을 이미 써보셨다면, 그때 저장된
> 내용은 새 표 형식과 호환되지 않습니다. 시트에서 기존 `Latest`/`Backups` 탭을
> 지우거나 내용을 비워두시면, 다음 저장 때 새 형식으로 다시 채워집니다.

## 5. 무료로만 쓰고 싶은 경우 참고

Render 무료 웹서비스 자체는 계속 무료로 유지 가능합니다 (이 프록시는 로컬 저장소가
필요 없어서 Render의 "무료는 재시작 시 파일 초기화" 제약과 무관합니다). 다만
Google Sheets API에는 자체 호출 한도가 있으니, 아주 잦은 폴링/자동 새로고침 로직이
`index.html`에 있다면 그 주기를 너무 짧게 잡지 않는 게 좋습니다.
