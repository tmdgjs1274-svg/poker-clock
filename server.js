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
  const trimmed = raw.trim();
  let json;
  try {
    // base64로 인코딩하는 걸 깜빡하고 JSON 원문을 그대로 넣은 경우도 그냥 동작하게 허용한다.
    json = trimmed.startsWith('{') ? JSON.parse(trimmed) : JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 값이 올바른 JSON도, 올바른 base64도 아닙니다. ' +
        '서비스 계정 JSON 키 파일 전체를 다시 base64로 인코딩해서 넣어주세요.'
    );
  }
  if (!json.client_email || !json.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 안에 client_email 또는 private_key가 없습니다. 파일 전체를 넣었는지 확인해주세요.');
  }
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

// ---------------------------------------------------------------------------
// 시트 레이아웃 (사람이 열어봐도 읽을 수 있게, 표 형태로 저장한다):
//   Templates       : id | name | anteEnabled | structure   (템플릿 하나당 한 행)
//   Latest          : key | value                            (레이아웃/테마/마지막 선택 템플릿 등 "설정"만, 행 몇 개)
//   Backups         : id | name | savedAt | activeTemplateId | nextTemplateId | theme | layout  (백업 하나당 한 행)
//   BackupTemplates : backupId | id | name | anteEnabled | structure   (백업 스냅샷 안의 템플릿마다 한 행)
// structure 칸만 레벨/휴식 배열이 그대로 JSON 문자열로 들어간다(그 안까지 행으로 쪼개면
// 너무 복잡해져서, 템플릿 단위까지만 행으로 나눴다).
// ---------------------------------------------------------------------------

const TEMPLATE_HEADERS = ['id', 'name', 'anteEnabled', 'structure'];
const LATEST_HEADERS = ['key', 'value'];
const BACKUP_HEADERS = ['id', 'name', 'savedAt', 'activeTemplateId', 'nextTemplateId', 'theme', 'layout'];
const BACKUP_TEMPLATE_HEADERS = ['backupId', 'id', 'name', 'anteEnabled', 'structure'];
const ALL_TABS = ['Templates', 'Latest', 'Backups', 'BackupTemplates'];

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// 필요한 탭이 시트에 없으면 자동으로 만들어준다 (사용자가 미리 탭을 만들어둘 필요가 없게).
async function ensureTabs(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' });
  const existing = new Set((meta.data.sheets || []).map((s) => s.properties.title));
  const missing = ALL_TABS.filter((t) => !existing.has(t));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
    });
  }
}

// 헤더 행 아래 데이터 행들을 읽어서 {헤더명: 값} 객체 배열로 돌려준다.
async function readTable(sheets, tab, headers) {
  const range = `${tab}!A2:${colLetter(headers.length)}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const rows = res.data.values || [];
  return rows
    .filter((r) => r.some((c) => c !== '' && c != null))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = r[i] ?? '';
      });
      return obj;
    });
}

// 헤더 행 + 데이터 행 전체를 새로 씀 (기존 내용은 지우고 통째로 다시 쓰는 방식 —
// 개인용 도구 규모에서는 이 편이 특정 행만 골라 지우는 것보다 훨씬 단순하고 안전하다).
async function writeTable(sheets, tab, headers, rows) {
  const lastCol = colLetter(headers.length);
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${tab}!A1:${lastCol}100000` });
  const values = [headers, ...rows.map((r) => headers.map((h) => (r[h] === undefined || r[h] === null ? '' : r[h])))];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

function templateToRow(t) {
  return {
    id: String(t.id ?? ''),
    name: t.name || '',
    anteEnabled: t.anteEnabled === false ? 'false' : 'true',
    structure: JSON.stringify(t.structure || []),
  };
}
function rowToTemplate(r) {
  let structure = [];
  try {
    structure = JSON.parse(r.structure || '[]');
  } catch (e) {
    structure = [];
  }
  return { id: Number(r.id) || 0, name: r.name || '', anteEnabled: r.anteEnabled !== 'false', structure };
}
function rowsToMap(rows) {
  const m = {};
  rows.forEach((r) => {
    m[r.key] = r.value;
  });
  return m;
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
  await ensureTabs(sheets);
  switch (action) {
    case 'loadLatest': {
      const settings = rowsToMap(await readTable(sheets, 'Latest', LATEST_HEADERS));
      if (!settings.updatedAt) return res.json({ ok: true }); // 아직 저장된 최신본 없음
      const templates = (await readTable(sheets, 'Templates', TEMPLATE_HEADERS)).map(rowToTemplate);
      const data = {
        templates,
        activeTemplateId: Number(settings.activeTemplateId) || templates[0]?.id || 1,
        nextTemplateId: Number(settings.nextTemplateId) || templates.reduce((m, t) => Math.max(m, t.id), 0) + 1,
        theme: settings.theme || 'light',
        layout: settings.layout || '1',
      };
      return res.json({ ok: true, data, updatedAt: settings.updatedAt });
    }
    case 'saveLatest': {
      const data = params.data || {};
      const templates = Array.isArray(data.templates) ? data.templates : [];
      await writeTable(sheets, 'Templates', TEMPLATE_HEADERS, templates.map(templateToRow));
      const updatedAt = new Date().toISOString();
      await writeTable(sheets, 'Latest', LATEST_HEADERS, [
        { key: 'theme', value: data.theme || '' },
        { key: 'layout', value: data.layout || '' },
        { key: 'activeTemplateId', value: String(data.activeTemplateId ?? '') },
        { key: 'nextTemplateId', value: String(data.nextTemplateId ?? '') },
        { key: 'updatedAt', value: updatedAt },
      ]);
      return res.json({ ok: true, updatedAt });
    }
    case 'listBackups': {
      const rows = await readTable(sheets, 'Backups', BACKUP_HEADERS);
      return res.json({ ok: true, backups: rows.map(({ id, name, savedAt }) => ({ id, name, savedAt })) });
    }
    case 'loadBackup': {
      const rows = await readTable(sheets, 'Backups', BACKUP_HEADERS);
      const found = rows.find((b) => b.id === params.id);
      if (!found) return res.json({ ok: false, error: '백업을 찾을 수 없습니다.' });
      const templates = (await readTable(sheets, 'BackupTemplates', BACKUP_TEMPLATE_HEADERS))
        .filter((r) => r.backupId === params.id)
        .map(rowToTemplate);
      const data = {
        templates,
        activeTemplateId: Number(found.activeTemplateId) || templates[0]?.id || 1,
        nextTemplateId: Number(found.nextTemplateId) || templates.reduce((m, t) => Math.max(m, t.id), 0) + 1,
        theme: found.theme || 'light',
        layout: found.layout || '1',
      };
      return res.json({ ok: true, data, name: found.name, savedAt: found.savedAt });
    }
    case 'saveBackup': {
      const data = params.data || {};
      const templates = Array.isArray(data.templates) ? data.templates : [];
      const id = genId();
      const savedAt = new Date().toISOString();

      const backupRows = await readTable(sheets, 'Backups', BACKUP_HEADERS);
      backupRows.push({
        id,
        name: params.name || '',
        savedAt,
        activeTemplateId: String(data.activeTemplateId ?? ''),
        nextTemplateId: String(data.nextTemplateId ?? ''),
        theme: data.theme || '',
        layout: data.layout || '',
      });
      // 너무 오래되면 앞(오래된 것)부터 정리 — 프론트가 listBackups 결과를 reverse()해서
      // 최신순으로 보여주므로, 여기 배열은 오래된 게 앞, 최신이 뒤 순서를 유지해야 한다.
      const trimmedIds = new Set();
      if (backupRows.length > MAX_BACKUPS) {
        backupRows.splice(0, backupRows.length - MAX_BACKUPS).forEach((b) => trimmedIds.add(b.id));
      }
      await writeTable(sheets, 'Backups', BACKUP_HEADERS, backupRows);

      let btRows = await readTable(sheets, 'BackupTemplates', BACKUP_TEMPLATE_HEADERS);
      if (trimmedIds.size) btRows = btRows.filter((r) => !trimmedIds.has(r.backupId));
      btRows = btRows.concat(templates.map((t) => Object.assign({ backupId: id }, templateToRow(t))));
      await writeTable(sheets, 'BackupTemplates', BACKUP_TEMPLATE_HEADERS, btRows);

      return res.json({ ok: true, id, savedAt });
    }
    case 'deleteBackup': {
      const backupRows = await readTable(sheets, 'Backups', BACKUP_HEADERS);
      await writeTable(sheets, 'Backups', BACKUP_HEADERS, backupRows.filter((b) => b.id !== params.id));
      const btRows = await readTable(sheets, 'BackupTemplates', BACKUP_TEMPLATE_HEADERS);
      await writeTable(sheets, 'BackupTemplates', BACKUP_TEMPLATE_HEADERS, btRows.filter((r) => r.backupId !== params.id));
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
