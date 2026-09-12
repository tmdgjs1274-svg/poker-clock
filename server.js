// 포커 토너먼트 클락 - 구글시트 DB용 Render 중계 서버
//
// 기존 Google Apps Script 웹앱(doGet/doPost, /exec URL)을 대체합니다.
// DB는 그대로 Google Sheets를 사용하고, 이 서버는 그 사이를 잇는 역할만 합니다.
// (Render 무료 웹서비스는 재시작/슬립 때 로컬 파일이 날아가지만, 이 서버는
//  로컬에 아무것도 저장하지 않고 매 요청마다 구글시트를 읽고 쓰므로 문제 없습니다.)
//
// 이 파일의 action별 요청/응답 형식은 실제 index.html의 dbFetchGet/dbFetchPost 및
// 관련 이벤트 핸들러 코드를 그대로 보고 맞춘 것입니다 (추정 아님):
//   - loadLatest   (GET)  -> { ok, data?, updatedAt? }            data/updatedAt은 저장된 게 없으면 생략
//   - saveLatest   (POST, {data})            -> { ok, updatedAt }
//   - listBackups  (GET)  -> { ok, backups:[{id,name,savedAt}, ...] }
//   - loadBackup   (GET,  {id})              -> { ok, data, name, savedAt }
//   - saveBackup   (POST, {name,data})       -> { ok, id, savedAt }
//   - deleteBackup (POST, {id})              -> { ok }
// 실패 시에는 항상 { ok:false, error:'...' } 형태로 응답합니다.

import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
// index.html의 dbFetchPost는 Apps Script CORS 프리플라이트를 피하려고
// Content-Type: text/plain으로 JSON을 보낸다. express.json()의 기본 type 필터는
// application/json만 인식하므로, text/plain도 함께 JSON으로 파싱하도록 넓혀준다.
app.use(express.json({ limit: '2mb', type: ['application/json', 'text/plain'] }));

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SHEET_ID = process.env.SHEET_ID;
const MAX_BACKUPS = 50;

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 환경변수가 설정되어 있지 않습니다.');
  const json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  return new google.auth.JWT(json.client_email, null, json.private_key, [
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
}

async function getSheets() {
  if (!SHEET_ID) throw new Error('SHEET_ID 환경변수가 설정되어 있지 않습니다.');
  const auth = getAuth();
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function readCellJson(sheets, tab, fallback) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1` });
  const v = res.data.values?.[0]?.[0];
  if (!v) return fallback;
  try {
    return JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

async function writeCellJson(sheets, tab, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[JSON.stringify(value)]] },
  });
}

function checkPassword(pw, res) {
  if (!APP_PASSWORD) return true; // 비밀번호 미설정 시 통과 (운영 권장 X)
  if (pw !== APP_PASSWORD) {
    res.status(401).json({ ok: false, error: '비밀번호가 올바르지 않습니다.' });
    return false;
  }
  return true;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function handleAction(action, params, res) {
  const sheets = await getSheets();
  switch (action) {
    case 'loadLatest': {
      // Latest 셀에는 { updatedAt, data } 봉투(envelope)를 그대로 저장해둔다.
      const envelope = await readCellJson(sheets, 'Latest', null);
      if (!envelope || !envelope.updatedAt) return res.json({ ok: true }); // 아직 저장된 최신본 없음
      return res.json({ ok: true, data: envelope.data, updatedAt: envelope.updatedAt });
    }
    case 'saveLatest': {
      const updatedAt = new Date().toISOString();
      await writeCellJson(sheets, 'Latest', { updatedAt, data: params.data ?? null });
      return res.json({ ok: true, updatedAt });
    }
    case 'listBackups': {
      const list = await readCellJson(sheets, 'Backups', []);
      const summary = (Array.isArray(list) ? list : []).map(({ id, name, savedAt }) => ({ id, name, savedAt }));
      return res.json({ ok: true, backups: summary });
    }
    case 'loadBackup': {
      const list = await readCellJson(sheets, 'Backups', []);
      const found = (Array.isArray(list) ? list : []).find((b) => b.id === params.id);
      if (!found) return res.json({ ok: false, error: '백업을 찾을 수 없습니다.' });
      return res.json({ ok: true, data: found.data, name: found.name, savedAt: found.savedAt });
    }
    case 'saveBackup': {
      const list = await readCellJson(sheets, 'Backups', []);
      const arr = Array.isArray(list) ? list : [];
      const entry = {
        id: genId(),
        name: params.name || '',
        savedAt: new Date().toISOString(),
        data: params.data ?? null,
      };
      arr.push(entry); // 오래된 것 먼저, 최신이 맨 뒤 (프론트에서 reverse()해서 최신순으로 보여줌)
      if (arr.length > MAX_BACKUPS) arr.splice(0, arr.length - MAX_BACKUPS); // 너무 오래되면 앞에서부터 정리
      await writeCellJson(sheets, 'Backups', arr);
      return res.json({ ok: true, id: entry.id, savedAt: entry.savedAt });
    }
    case 'deleteBackup': {
      const list = await readCellJson(sheets, 'Backups', []);
      const arr = Array.isArray(list) ? list : [];
      await writeCellJson(sheets, 'Backups', arr.filter((b) => b.id !== params.id));
      return res.json({ ok: true });
    }
    default:
      return res.json({ ok: false, error: `알 수 없는 action: ${action}` });
  }
}

app.get('/exec', async (req, res) => {
  const { action, password, ...rest } = req.query;
  if (!checkPassword(password, res)) return;
  try {
    await handleAction(action, rest, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post('/exec', async (req, res) => {
  const { action, password, ...rest } = req.body || {};
  if (!checkPassword(password, res)) return;
  try {
    await handleAction(action, rest, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// 포커 클락 화면(index.html) 자체도 이 서버가 같이 서빙한다.
// 그래서 이 서비스 주소로 그냥 접속하면 바로 클락 화면이 뜨고,
// "구글시트 DB 연결" 모달의 URL도 이미 이 서버 자신(/exec)으로 채워져 있다.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('poker-clock-render-proxy: OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`poker-clock-render-proxy listening on ${PORT}`));
