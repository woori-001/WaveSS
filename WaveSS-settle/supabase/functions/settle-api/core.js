// 정산 관리 · 서버 로직 (구 Apps Script Code.gs 를 Supabase Edge Function 용으로 이식)
// - 저장소: Postgres 테이블 settle_*  (행 = data jsonb, 시트 열 이름 그대로)
// - 호출: handle(fn, args, ctx)  ctx = { email, db(service_role supabase client) }
import { AsyncLocalStorage } from 'node:async_hooks';

export const IND_COLS = ['No', '정산종류', '고객명', '속성', '명의자연락처', '가입서비스', '상품명', '상품옵션', '회선수', '셋트유형', '협력점', '유치자', '접수일', '개통일',
  '개통상태', '접수경로', '사은품', '상부정산', '약정금액', '차감내역-사은품', '차감내역-물류', '차감내역-쿠폰', '차감내역-선납', '차감내역-할인탭', '차감내역-미비서류', '차감내역-기타', '수납', '번들수수료', '동판수수료', '정산금액', '정산 비고'];

// 논리 이름 → 테이블 (settle_ 접두사는 db 계층에서 붙임)
export const T = {
  CONFIG: 'config', MONTHS: 'months', ITEMS: 'items', MEMOS: 'memos', IMAGES: 'images',
  PENALTY: 'penalty', TEAMS: 'teams', EMP: 'employees',
  WZ: 'wisely', WZD: 'wisely_detail', SKY: 'sky', SKYD: 'sky_detail', UP: 'upsell', UPD: 'upsell_detail',
  ADJ: 'adj', BONUS: 'bonus', IND: 'indiv', INDD: 'indiv_detail', APPR: 'approval', RF: 'refund', RO: 'occur', CL: 'close', CLD: 'close_detail',
};
const SECTIONS = ['bonus', 'channel', 'penalty'];
const BUCKET = 'settle-images';

/* ───────────────── 요청 컨텍스트 ───────────────── */
const als = new AsyncLocalStorage();       // 요청별 { email, db, memo } — 동시 요청 간 섞이지 않음
function ctx() { const c = als.getStore(); if (!c) throw new Error('no ctx'); return c; }

/* ───────────────── DB 계층 ───────────────── */
// 테이블 전체(또는 해당 월)의 행을 시트 열 이름 그대로의 객체 배열로. 한 요청 안에서는 메모이즈.
async function readRows(name, month) {
  const { db, memo } = ctx();
  const key = name + '|' + (month || '*');
  if (memo[key]) return memo[key];
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = db.from('settle_' + name).select('data').order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (month) q = q.eq('month', month);
    const { data, error } = await q;
    if (error) throw new Error(`${name} 읽기 실패: ${error.message}`);
    for (const r of data) out.push(r.data || {});
    if (data.length < PAGE) break;
  }
  memo[key] = out;
  return out;
}
// 월(+지역) 범위를 지우고 새 행을 씀. month/region 이 null 이면 그 조건은 무시(= 테이블 전체 교체)
async function replaceRows(name, month, region, rows) {
  const { db, memo } = ctx();
  Object.keys(memo).forEach(k => { if (k.startsWith(name + '|')) delete memo[k]; });
  const { error } = await db.rpc('settle_replace', { p_table: name, p_month: month ?? null, p_region: region ?? null, p_rows: rows || [] });
  if (error) throw new Error(`${name} 저장 실패: ${error.message}`);
}
async function distinctMonths(name) {
  const { db } = ctx();
  const { data, error } = await db.from('settle_' + name).select('month').not('month', 'is', null);
  if (error) throw new Error(`${name} 월 목록 실패: ${error.message}`);
  const set = {}; data.forEach(r => { const k = monthKey(r.month); if (k) set[k] = 1; });
  return Object.keys(set).sort().reverse();
}

/* ───────────────── 공통 헬퍼 ───────────────── */
function monthKey(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 7) : s;
}
function fmtDate(v) { if (!v) return ''; return String(v).slice(0, 10); }
function kst(d, withTime) {
  const t = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  const s = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
  return withTime ? `${s} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}` : s;
}
function now() { return kst(new Date(), true); }
const RANK_RE = /(사원|주임|대리|과장|차장|부장|팀장|실장|매니저|프로|인턴|님)$/;
function normNameGs(n) { let k = String(n || '').replace(/\s+/g, '').replace(/\(.*?\)/g, '').replace(RANK_RE, '').replace(/\d+$/, '').trim(); if (/^(퇴|휴)/.test(k) && k.length >= 3) k = k.slice(1); return k; }
function checkMonth(month) { if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('월 형식은 YYYY-MM 입니다.'); }

/* ───────────────── 설정 / 권한 ───────────────── */
async function configMap() {
  const m = {};
  (await readRows(T.CONFIG)).forEach(r => { if (r['키']) m[String(r['키'])] = String(r['값'] == null ? '' : r['값']); });
  return m;
}
async function getConfig(key) { return (await configMap())[key] || ''; }
async function setConfig(key, value) {
  const rows = await readRows(T.CONFIG);
  const hit = rows.find(r => r['키'] === key);
  if (hit) hit['값'] = value; else rows.push({ '키': key, '값': value, '설명': '' });
  await replaceRows(T.CONFIG, null, null, rows);
}
function currentUser() { return ctx().email || ''; }
async function editorList() { return (await getConfig('편집자')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
async function isEditor() { const me = currentUser().toLowerCase(); return !!me && (await editorList()).includes(me); }
async function currentEmployee() {
  const me = currentUser().toLowerCase(); if (!me) return null;
  const e = (await readSettings()).employees.find(x => x.email && x.email.toLowerCase() === me);
  if (!e) return null;
  e.leader = /팀장/.test(e.rank || '');
  e.region = String(e.team || '').replace(/\s*\d*\s*팀$/, '').trim();
  return e;
}
async function requireEditor() { if (!(await isEditor())) throw new Error('편집 권한이 없습니다. (설정 > 편집자 목록을 확인하세요)'); }

/* ───────────────── 초기 로드 ───────────────── */
async function getInit(wantMonth) {
  const appName = (await getConfig('앱이름')) || '정산 관리';
  if (!(await isEditor())) {
    const me = await currentEmployee();
    if (!me) return { user: currentUser(), role: 'none', appName };
    const st = await readSettings();
    return { user: currentUser(), role: 'emp', appName, me, settings: { teams: st.teams, employees: me.leader ? st.employees.map(x => ({ name: x.name, rank: x.rank, team: x.team, status: x.status })) : [me] }, myMonths: await myMonths(me), bonusMonths: await myBonusMonths(me) };
  }
  const months = await readMonths();
  const pick = (wantMonth && months.some(m => m.month === wantMonth)) ? wantMonth : (months[0] ? months[0].month : null);
  return {
    user: currentUser(), editor: true, role: 'editor', appName, months,
    month: pick ? await readMonth(pick) : null,
    settings: await readSettings(true),
    penaltyMonths: await distinctMonths(T.PENALTY), wiselyMonths: await distinctMonths(T.WZ), skyMonths: await distinctMonths(T.SKY), upMonths: await distinctMonths(T.UP),
    adjMonths: await distinctMonths(T.ADJ), bonusMonths: await distinctMonths(T.BONUS), indivMonths: await distinctMonths(T.IND), apprMonths: await distinctMonths(T.APPR),
    refundMonths: await distinctMonths(T.RF), occurMonths: await distinctMonths(T.RO), closeMonths: await distinctMonths(T.CL),
  };
}

/* ───────────────── 정산 기준 ───────────────── */
async function listMonths() { await requireEditor(); return readMonths(); }
async function readMonths() {
  return (await readRows(T.MONTHS)).map(r => ({
    month: monthKey(r['월']), status: r['상태'] || '작성중',
    dueSiheung: r['시흥마감일'] || '', dueCheonan: r['천안마감일'] || '',
    confirmSiheung: fmtDate(r['시흥확인일']), confirmCheonan: fmtDate(r['천안확인일']),
    note: r['비고'] || '', updatedAt: r['수정일'] || '', updatedBy: r['수정자'] || '',
  })).sort((a, b) => b.month.localeCompare(a.month));
}
async function getMonth(month) { await requireEditor(); return readMonth(month); }
async function getMyCriteria(month) {
  if (!(await isEditor())) { const me = await currentEmployee(); if (!me || !me.leader) throw new Error('권한이 없습니다.'); }
  const months = (await readMonths()).map(m => m.month);
  return { months, data: month && months.includes(month) ? await readMonth(month) : null };
}
const itemObj = r => ({ section: r['섹션'], tag: r['구분'], name: r['명칭'], amount: r['금액'], body: r['내용'], memo: r['메모'] });
const bySeq = (a, b) => Number(a['순서']) - Number(b['순서']);
async function readMonth(month) {
  const metas = await readMonths();
  const meta = metas.find(m => m.month === month);
  if (!meta) return null;
  const items = (await readRows(T.ITEMS, month)).sort(bySeq).map(itemObj);
  const sections = {}; SECTIONS.forEach(s => sections[s] = items.filter(i => i.section === s));
  const memos = (await readRows(T.MEMOS, month)).sort(bySeq).map(r => r['내용']);
  const prevMeta = metas.filter(m => m.month < month)[0] || null;
  let prev = null;
  if (prevMeta) {
    const pItems = (await readRows(T.ITEMS, prevMeta.month)).sort(bySeq).map(itemObj);
    const pSections = {}; SECTIONS.forEach(s => pSections[s] = pItems.filter(i => i.section === s));
    prev = { month: prevMeta.month, sections: pSections };
  }
  return { meta, sections, memos, images: await readImages(month), prev };
}
async function saveMonth(payload) {
  await requireEditor();
  const month = payload.month; checkMonth(month);
  const items = [];
  SECTIONS.forEach(s => (payload.sections[s] || []).forEach((it, i) =>
    items.push({ '월': month, '섹션': s, '순서': i + 1, '구분': it.tag || '', '명칭': it.name || '', '금액': it.amount || '', '내용': it.body || '', '메모': it.memo || '' })));
  await replaceRows(T.ITEMS, month, null, items);
  const memos = (payload.memos || []).filter(m => String(m).trim()).map((m, i) => ({ '월': month, '순서': i + 1, '내용': m }));
  await replaceRows(T.MEMOS, month, null, memos);
  const m = payload.meta || {};
  await replaceRows(T.MONTHS, month, null, [{ '월': month, '상태': m.status || '작성중', '시흥마감일': m.dueSiheung || '', '천안마감일': m.dueCheonan || '',
    '시흥확인일': m.confirmSiheung || '', '천안확인일': m.confirmCheonan || '', '비고': m.note || '', '수정일': now(), '수정자': currentUser() }]);
  return getMonth(month);
}
async function createMonth(month, copyFrom) {
  await requireEditor(); checkMonth(month);
  if ((await readMonths()).some(m => m.month === month)) throw new Error(month + ' 은(는) 이미 존재합니다.');
  const src = copyFrom ? await readMonth(copyFrom) : null;
  return saveMonth({ month, meta: { status: '작성중', dueSiheung: src ? src.meta.dueSiheung : '', dueCheonan: src ? src.meta.dueCheonan : '' }, sections: src ? src.sections : defaultSections(), memos: [] });
}
async function deleteMonth(month) {
  await requireEditor();
  await replaceRows(T.ITEMS, month, null, []); await replaceRows(T.MEMOS, month, null, []); await replaceRows(T.MONTHS, month, null, []);
  return listMonths();
}
function defaultSections() {
  return {
    bonus: [
      { tag: '건당', name: '(조건1)비광고채널', amount: '+5만 원', body: '광고비 없는 채널 추가매출 건당+5만원 (아웃콜)', memo: '' },
      { tag: '달성보너스', name: '(조건2)매출달성 보너스', amount: '+200만 원', body: '매출(가산매출포함)1700만원 초과시 매출+200만원 / 매월1회 적용', memo: '' },
    ],
    channel: [
      { tag: '제휴', name: '와이즐리(유선)', amount: '5만 원/건당', body: '4월접수건 부터 → 건당 5만원\n** 스카이는 유치자 변경 없음(건당X), 유치자 매출 반영', memo: '' },
      { tag: '제휴', name: '와이즐리(무선)', amount: '10만 원/건당', body: '동판메인회선만 해당\n**스카이유심, 가족회선, 기기는 유치자변경없음(건당X), 유치자 매출반영', memo: '' },
      { tag: '별도채널', name: '뽐뿌', amount: '', body: '매출 4만원 미만 시 매출보정', memo: '조정위치 : 기타차감' },
      { tag: '제휴', name: '모바일-SK,LG,KT', amount: '5만 원/건당', body: '가족회선만 해당\n**대표회선, 기기는 미포함', memo: '' },
      { tag: '별도채널', name: '스카이유심', amount: '', body: '건당롯상 5천원 / 매출은 시흥영업팀 팀결산으로 반영 (1,2팀 일때는 5:5반영)', memo: '롯상 별도지급' },
      { tag: '별도채널', name: '업셀링(KT,SK)', amount: '', body: '건당롯상 5천원 / 매출은 시흥영업팀 팀결산(1,2팀 일때는 5:5반영)\n(수수료(상부)-쿠폰(전체)=매출 > 팀결산반영)', memo: '롯상 별도지급' },
      { tag: '별도채널', name: '전체경로', amount: '', body: '26-05-29 접수건 부터~\n매출4만원 미만~ -5만원까지 → 4만원 보정\n단,리뷰이벤트 필수 / 상담녹취 검수필수(영업팀장검수)', memo: '받은 리스트\n매출보정반영' },
    ],
    penalty: [
      { tag: '환수 발생', name: '', amount: '', body: '당월 매출금액 차감\n정산예정일 발생일 기준 시흥 익월15일, 천안 익월25일', memo: '' },
      { tag: '채증 패널티', name: '', amount: '', body: '영업자 매출반영X → 팀별 결산 차감(리스트업 후 경지 전달)', memo: '' },
      { tag: '사은품 환수완료', name: '', amount: '', body: '환수완료시 매출보정\n환수일 기준 익월15일/25일 정산예정일 반영', memo: '' },
      { tag: '환수 발생', name: '', amount: '', body: '26년 이전 개통분 환수 발생 시 → 영업자 매출반영 XX\n(팀별결산에 반영)\n**시흥영업팀 퇴사자/부천영업팀 → (26년 이전 개통건)은 팀결산에서도 제외(회사비용처리)', memo: '' },
      { tag: '사은품 환수완료', name: '', amount: '', body: '26년 이전 개통 환수건\n휴,퇴사자 환수건\n시흥 → 환수금액의 5% 환수자 인센반영\n천안 → 환수금액의 5% 광연부장님 인센반영', memo: '' },
    ],
  };
}

/* ───────────────── 이미지 (Supabase Storage) ───────────────── */
async function listImages(month) { await requireEditor(); return readImages(month); }
async function readImages(month) {
  const { db } = ctx();
  const rows = (await readRows(T.IMAGES, month));
  if (!rows.length) return [];
  const paths = rows.map(r => r['파일경로']).filter(Boolean);
  const urls = {};
  if (paths.length) {
    const { data } = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
    (data || []).forEach(s => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
  }
  return rows.map(r => ({ name: r['파일명'], id: r['파일경로'], url: urls[r['파일경로']] || '', uploadedAt: r['업로드일'], uploadedBy: r['업로더'] }));
}
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function uploadImage(month, fileName, mimeType, base64) {
  await requireEditor(); checkMonth(month);
  const { db } = ctx();
  const safe = String(fileName || 'image.png').replace(/[\/\\?#%]/g, '_');
  const path = `${month}/${Date.now()}_${safe}`;
  const { error } = await db.storage.from(BUCKET).upload(path, b64ToBytes(base64), { contentType: mimeType || 'image/png', upsert: false });
  if (error) throw new Error('업로드 실패: ' + error.message);
  const rows = await readRows(T.IMAGES, month);
  rows.push({ '월': month, '파일명': fileName, '파일경로': path, '업로드일': now(), '업로더': currentUser() });
  await replaceRows(T.IMAGES, month, null, rows);
  return readImages(month);
}
async function getImageData(path) {
  await requireEditor();
  const { db } = ctx();
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 600);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
async function deleteImage(month, path) {
  await requireEditor();
  const { db } = ctx();
  try { await db.storage.from(BUCKET).remove([path]); } catch (_) { /* ignore */ }
  const rows = (await readRows(T.IMAGES, month)).filter(r => String(r['파일경로']) !== String(path));
  await replaceRows(T.IMAGES, month, null, rows);
  return readImages(month);
}

/* ───────────────── 설정: 팀 / 사원 / 편집자 ───────────────── */
async function getSettings() { await requireEditor(); return readSettings(true); }
async function readSettings(withEditors) {
  const teams = (await readRows(T.TEAMS)).filter(r => String(r['팀명'] || '').trim()).sort(bySeq).map(r => String(r['팀명']).trim());
  const employees = (await readRows(T.EMP)).filter(r => String(r['이름'] || '').trim()).sort(bySeq)
    .map(r => ({ name: String(r['이름']).trim(), rank: String(r['직급'] || '').trim(), team: String(r['팀'] || '').trim(), status: String(r['상태'] || '재직').trim(), email: String(r['이메일'] || '').trim() }));
  const out = { teams, employees };
  if (withEditors) { out.editors = (await editorList()).join(', '); out.appName = (await getConfig('앱이름')) || '정산 관리'; }
  return out;
}
async function saveSettings(p) {
  await requireEditor();
  const teams = (p.teams || []).map(t => String(t || '').trim()).filter(Boolean);
  await replaceRows(T.TEAMS, null, null, teams.map((t, i) => ({ '순서': i + 1, '팀명': t })));
  const emps = (p.employees || []).filter(e => String(e.name || '').trim());
  await replaceRows(T.EMP, null, null, emps.map((e, i) => ({ '순서': i + 1, '이름': String(e.name).trim(), '직급': String(e.rank || '').trim(), '팀': e.team || '', '상태': e.status || '재직', '이메일': String(e.email || '').trim().toLowerCase() })));
  if (typeof p.editors === 'string') {
    const list = p.editors.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!list.includes(currentUser().toLowerCase())) throw new Error('편집자 목록에서 본인 계정을 뺄 수 없습니다.');
    await setConfig('편집자', list.join(','));
  }
  if (typeof p.appName === 'string' && p.appName.trim()) await setConfig('앱이름', p.appName.trim());
  return getSettings();
}

/* ───────────────── 채증 패널티 ───────────────── */
function lastUpd(rows) { const l = rows.map(r => [r['수정일'], r['수정자']]).sort((a, b) => String(b[0]).localeCompare(String(a[0])))[0] || ['', '']; return { updatedAt: l[0] || '', updatedBy: l[1] || '' }; }
async function getPenalty(month) {
  await requireEditor();
  const all = (await readRows(T.PENALTY, month)).sort(bySeq);
  const rows = all.map(r => ({ team: r['팀'], emp: r['유치자'], carrier: r['통신사'], customer: r['고객명'], serial: r['서번'], amount: Number(r['금액']) || 0, note: r['비고'] }));
  return { month, rows, ...lastUpd(all), months: await distinctMonths(T.PENALTY) };
}
async function savePenalty(month, rows) {
  await requireEditor(); checkMonth(month);
  const ts = now(), who = currentUser();
  const out = (rows || []).filter(r => String(r.emp || r.customer || r.serial || '').trim()).map((r, i) => ({
    '월': month, '순서': i + 1, '팀': r.team || '', '유치자': r.emp || '', '통신사': r.carrier || '', '고객명': r.customer || '',
    '서번': r.serial || '', '금액': Number(r.amount) || 0, '비고': r.note || '', '수정일': ts, '수정자': who }));
  await replaceRows(T.PENALTY, month, null, out);
  return getPenalty(month);
}

/* ───────────────── 와이즐리 ───────────────── */
async function wiselyPrices(month) {
  const parse = t => { const m = String(t || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(만)?/); if (!m) return 0; return Math.round(Number(m[1]) * (m[2] ? 10000 : 1)); };
  let wired = 50000, mobile = 100000;
  (await readRows(T.ITEMS, month)).filter(r => String(r['명칭']).indexOf('와이즐리') >= 0).forEach(r => {
    const n = String(r['명칭']), p = parse(r['금액']);
    if (p && /유선/.test(n)) wired = p;
    if (p && /무선/.test(n)) mobile = p;
  });
  return { wired, mobile };
}
async function getWisely(month) {
  await requireEditor();
  const all = (await readRows(T.WZ, month)).sort(bySeq);
  const rows = all.map(r => ({ team: r['팀'], emp: r['토스자'], wired: Number(r['유선건']) || 0, mobile: Number(r['무선건']) || 0, wPrice: Number(r['유선단가']) || 0, mPrice: Number(r['무선단가']) || 0, amount: Number(r['금액']) || 0, note: r['비고'] }));
  const details = (await readRows(T.WZD, month)).sort(bySeq).map(r => ({ kind: r['유형'], customer: r['고객명'], product: r['상품명'], option: r['상품옵션'], recv: r['접수일'], open: r['개통일'], emp: r['토스자'], verdict: r['판정'] }));
  const prices = (rows.length && rows[0].wPrice) ? { wired: rows[0].wPrice, mobile: rows[0].mPrice } : await wiselyPrices(month);
  return { month, rows, details, ...lastUpd(all), months: await distinctMonths(T.WZ), prices };
}
async function saveWisely(month, rows, details) {
  await requireEditor(); checkMonth(month);
  const ts = now(), who = currentUser();
  await replaceRows(T.WZ, month, null, (rows || []).filter(r => String(r.emp || '').trim()).map((r, i) => ({
    '월': month, '순서': i + 1, '팀': r.team || '', '토스자': r.emp, '유선건': Number(r.wired) || 0, '무선건': Number(r.mobile) || 0,
    '유선단가': Number(r.wPrice) || 0, '무선단가': Number(r.mPrice) || 0,
    '금액': (Number(r.wired) || 0) * (Number(r.wPrice) || 0) + (Number(r.mobile) || 0) * (Number(r.mPrice) || 0),
    '비고': r.note || '', '수정일': ts, '수정자': who })));
  await replaceRows(T.WZD, month, null, (details || []).map((d, i) => ({ '월': month, '순서': i + 1, '유형': d.kind || '', '고객명': d.customer || '', '상품명': d.product || '',
    '상품옵션': d.option || '', '접수일': d.recv || '', '개통일': d.open || '', '토스자': d.emp || '', '판정': d.verdict || '' })));
  return getWisely(month);
}

/* ───────────────── 스카이유심 ───────────────── */
async function getSky(month) {
  await requireEditor();
  const all = (await readRows(T.SKY, month)).sort(bySeq);
  const rows = all.map(r => ({ team: r['팀'], ratio: Number(r['비율']) || 0, count: Number(r['건수']) || 0, amount: Number(r['금액']) || 0, mode: r['방식'], note: r['비고'] }));
  const details = (await readRows(T.SKYD, month)).sort(bySeq).map(r => ({ customer: r['고객명'], product: r['상품명'], option: r['상품옵션'], open: r['개통일'], status: r['개통상태'], kind: r['정산종류'], amount: Number(r['정산금액']) || 0, emp: r['유치자'] }));
  return { month, rows, details, mode: rows[0] ? rows[0].mode : '', ...lastUpd(all), months: await distinctMonths(T.SKY) };
}
async function saveSky(month, mode, rows, details) {
  await requireEditor(); checkMonth(month);
  const ts = now(), who = currentUser();
  await replaceRows(T.SKY, month, null, (rows || []).filter(r => String(r.team || '').trim()).map((r, i) => ({
    '월': month, '순서': i + 1, '팀': r.team, '비율': Number(r.ratio) || 0, '건수': Number(r.count) || 0, '금액': Number(r.amount) || 0, '방식': mode || '', '비고': r.note || '', '수정일': ts, '수정자': who })));
  await replaceRows(T.SKYD, month, null, (details || []).map((d, i) => ({ '월': month, '순서': i + 1, '고객명': d.customer || '', '상품명': d.product || '', '상품옵션': d.option || '',
    '개통일': d.open || '', '개통상태': d.status || '', '정산종류': d.kind || '', '정산금액': Number(d.amount) || 0, '유치자': d.emp || '' })));
  return getSky(month);
}

/* ───────────────── 업셀링 ───────────────── */
async function getUp(month) {
  await requireEditor();
  const all = (await readRows(T.UP, month)).sort(bySeq);
  const rows = all.map(r => ({ region: r['지역'], team: r['팀'], ratio: Number(r['비율']) || 0, count: Number(r['건수']) || 0, amount: Number(r['금액']) || 0, mode: r['방식'], note: r['비고'] }));
  const details = (await readRows(T.UPD, month)).sort(bySeq).map(r => ({ region: r['지역'], customer: r['고객명'], option: r['상품옵션'], open: r['개통일'], status: r['개통상태'], emp: r['유치자'], fee: Number(r['수수료']) || 0, amount: Number(r['정산금액']) || 0 }));
  const modes = {}; rows.forEach(r => { if (r.region && r.mode) modes[r.region] = r.mode; });
  return { month, rows, details, modes, ...lastUpd(all), months: await distinctMonths(T.UP) };
}
async function saveUp(month, rows, details) {
  await requireEditor(); checkMonth(month);
  const ts = now(), who = currentUser();
  await replaceRows(T.UP, month, null, (rows || []).filter(r => String(r.team || '').trim()).map((r, i) => ({
    '월': month, '순서': i + 1, '지역': r.region || '', '팀': r.team, '비율': Number(r.ratio) || 0, '건수': Number(r.count) || 0,
    '금액': Number(r.amount) || 0, '방식': r.mode || '', '비고': r.note || '', '수정일': ts, '수정자': who })));
  await replaceRows(T.UPD, month, null, (details || []).map((d, i) => ({ '월': month, '순서': i + 1, '지역': d.region || '', '고객명': d.customer || '', '상품옵션': d.option || '',
    '개통일': d.open || '', '개통상태': d.status || '', '유치자': d.emp || '', '수수료': Number(d.fee) || 0, '정산금액': Number(d.amount) || 0 })));
  return getUp(month);
}

/* ───────────────── 추가매출2 (보정) ───────────────── */
async function getAdj(month) {
  await requireEditor();
  const all = (await readRows(T.ADJ, month)).sort(bySeq);
  const regions = {};
  all.forEach(r => {
    const g = r['지역'] || ''; if (!regions[g]) regions[g] = { rows: [], summary: null, updatedAt: '', updatedBy: '' };
    const R = regions[g];
    if (String(r['수정일'] || '') > String(R.updatedAt || '')) { R.updatedAt = r['수정일'] || ''; R.updatedBy = r['수정자'] || ''; }
    if (r['상태'] === '요약') { let sm = null; try { if (String(r['비고'] || '')[0] === '{') sm = JSON.parse(r['비고']); } catch (_) {} R.summary = sm ? Object.assign({ total: Number(r['건수']) || 0 }, sm) : { total: Number(r['건수']) || 0, file: r['비고'] || '' }; return; }
    R.rows.push({ emp: r['유치자'] || '', customer: r['고객명'] || '', phone: r['연락처'] || '', rule: r['규칙'] || '', n: Number(r['건수']) || 0,
      amount: Number(r['정산금액']) || 0, need: Number(r['필요금액']) || 0, adj: Number(r['보정금액']) || 0, status: r['상태'] || '대상', reason: r['사유'] || '', note: r['비고'] || '' });
  });
  return { month, regions, months: await distinctMonths(T.ADJ) };
}
async function saveAdj(month, region, rows, summary) {
  await requireEditor(); checkMonth(month); if (!region) throw new Error('지역이 없습니다.');
  const ts = now(), who = currentUser(); const out = []; let i = 0;
  if (summary) out.push({ '월': month, '지역': region, '순서': ++i, '유치자': '', '고객명': '', '연락처': '', '규칙': '', '건수': Number(summary.total) || 0,
    '정산금액': 0, '필요금액': 0, '보정금액': 0, '상태': '요약', '사유': '', '비고': JSON.stringify({ file: summary.file || '', published: !!summary.published }), '수정일': ts, '수정자': who });
  (rows || []).forEach(r => out.push({ '월': month, '지역': region, '순서': ++i, '유치자': r.emp || '', '고객명': r.customer || '', '연락처': r.phone || '', '규칙': r.rule || '',
    '건수': Number(r.n) || 0, '정산금액': Number(r.amount) || 0, '필요금액': Number(r.need) || 0, '보정금액': Number(r.adj) || 0, '상태': r.status || '대상', '사유': r.reason || '', '비고': r.note || '', '수정일': ts, '수정자': who }));
  await replaceRows(T.ADJ, month, region, out);
  return getAdj(month);
}

/* ───────────────── 추가매출1 (건당) ───────────────── */
async function getBonus(month) {
  await requireEditor();
  const all = (await readRows(T.BONUS, month)).sort(bySeq);
  const regions = {};
  all.forEach(r => {
    const g = r['지역'] || ''; if (!regions[g]) regions[g] = { rows: [], summary: null, updatedAt: '', updatedBy: '' };
    const R = regions[g];
    if (String(r['수정일'] || '') > String(R.updatedAt || '')) { R.updatedAt = r['수정일'] || ''; R.updatedBy = r['수정자'] || ''; }
    if (r['상태'] === '요약') { try { R.summary = JSON.parse(r['비고'] || '{}'); } catch (_) { R.summary = {}; } return; }
    R.rows.push({ kind: r['종류'] || '', emp: r['유치자'] || '', customer: r['고객명'] || '', phone: r['연락처'] || '', product: r['상품'] || '', option: r['옵션'] || '',
      route: r['접수경로'] || '', open: r['개통일'] || '', price: Number(r['단가']) || 0, status: r['상태'] || '대상', reason: r['사유'] || '', note: r['비고'] || '' });
  });
  return { month, regions, months: await distinctMonths(T.BONUS) };
}
async function saveBonus(month, region, rows, summary) {
  await requireEditor(); checkMonth(month); if (!region) throw new Error('지역이 없습니다.');
  const ts = now(), who = currentUser(); const out = []; let i = 0;
  if (summary) out.push({ '월': month, '지역': region, '순서': ++i, '종류': '', '유치자': '', '고객명': '', '연락처': '', '상품': '', '옵션': '', '접수경로': '', '개통일': '',
    '단가': 0, '상태': '요약', '사유': '', '비고': JSON.stringify(summary), '수정일': ts, '수정자': who });
  (rows || []).forEach(r => out.push({ '월': month, '지역': region, '순서': ++i, '종류': r.kind || '', '유치자': r.emp || '', '고객명': r.customer || '', '연락처': r.phone || '',
    '상품': r.product || '', '옵션': r.option || '', '접수경로': r.route || '', '개통일': r.open || '', '단가': Number(r.price) || 0, '상태': r.status || '대상', '사유': r.reason || '', '비고': r.note || '', '수정일': ts, '수정자': who }));
  await replaceRows(T.BONUS, month, region, out);
  return getBonus(month);
}

/* ───────────────── 개별정산서 ───────────────── */
async function indivLookups(month) {
  const b1 = {}, b2 = {}, wz = {}, rf = {};
  (await readRows(T.BONUS, month)).filter(r => r['상태'] === '대상').forEach(r => {
    const k = normNameGs(r['유치자']); if (!k) return; b1[k] = b1[k] || { n: 0, amount: 0, kinds: {} };
    b1[k].n++; b1[k].amount += Number(r['단가']) || 0; b1[k].kinds[r['종류']] = (b1[k].kinds[r['종류']] || 0) + 1;
  });
  (await readRows(T.ADJ, month)).filter(r => r['상태'] === '대상').forEach(r => {
    const k = normNameGs(r['유치자']); if (!k) return; b2[k] = b2[k] || { n: 0, amount: 0 };
    b2[k].n++; b2[k].amount += Number(r['보정금액']) || 0;
  });
  (await readRows(T.WZ, month)).forEach(r => {
    const k = normNameGs(r['토스자']); if (!k) return; wz[k] = wz[k] || { wired: 0, mobile: 0, wiredAmt: 0, mobileAmt: 0 };
    const w = Number(r['유선건']) || 0, m = Number(r['무선건']) || 0;
    wz[k].wired += w; wz[k].mobile += m; wz[k].wiredAmt += w * (Number(r['유선단가']) || 0); wz[k].mobileAmt += m * (Number(r['무선단가']) || 0);
  });
  (await readRows(T.RF, month)).filter(r => r['고객명'] && r['구분'] === '개별' && String(r['보정제외']) !== '1' && !/환수관리/.test(String(r['환수자'] || ''))).forEach(r => {
    const k = normNameGs(r['유치자']); if (!k) return; rf[k] = rf[k] || { n: 0, amount: 0 };
    rf[k].n++; rf[k].amount += Number(r['입금액']) || 0;
  });
  return { bonus1: b1, bonus2: b2, wisely: wz, refundAdj: rf };
}
const indRowObj = r => ({ emp: r['유치자'], fee: Number(r['수수료']) || 0, cost: Number(r['비용']) || 0, extra: Number(r['추가기타']) || 0, refund: Number(r['환수차감']) || 0, toss: Number(r['토스비']) || 0, n: Number(r['전체건']) || 0, nIlban: Number(r['일반건']) || 0, note: r['비고'] || '' });
async function readIndivRegions(month) {
  const all = (await readRows(T.IND, month)).sort(bySeq);
  const regions = {};
  all.forEach(r => {
    const g = r['지역'] || ''; if (!regions[g]) regions[g] = { rows: [], summary: null, updatedAt: '', updatedBy: '' };
    const R = regions[g];
    if (String(r['수정일'] || '') > String(R.updatedAt || '')) { R.updatedAt = r['수정일'] || ''; R.updatedBy = r['수정자'] || ''; }
    if (r['유치자'] === '' || r['유치자'] == null) { try { R.summary = JSON.parse(r['비고'] || '{}'); } catch (_) { R.summary = {}; } return; }
    R.rows.push(indRowObj(r));
  });
  return regions;
}
async function getIndiv(month) {
  await requireEditor();
  return { month, regions: await readIndivRegions(month), lookups: await indivLookups(month), months: await distinctMonths(T.IND) };
}
function indDetailObj(r) { const o = {}; IND_COLS.forEach(k => o[k] = r[k] == null ? '' : r[k]); return o; }
async function indSummaryOf(month, region) {
  const r = (await readRows(T.IND, month)).find(x => (x['지역'] || '') === region && (x['유치자'] === '' || x['유치자'] == null));
  if (!r) return null; try { return JSON.parse(r['비고'] || '{}'); } catch (_) { return {}; }
}
async function getIndivDetails(month, region, emp) {
  if (!(await isEditor())) { const me = await currentEmployee(); if (!me) throw new Error('권한이 없습니다.');
    if (normNameGs(me.name) !== normNameGs(emp)) { if (!(me.leader && me.region === region && ((await indSummaryOf(month, region)) || {}).published)) throw new Error('권한이 없습니다.'); } }
  const k = normNameGs(emp);
  return (await readRows(T.INDD, month)).filter(r => (r['지역'] || '') === region && normNameGs(r['유치자']) === k).sort(bySeq).map(indDetailObj);
}
async function setIndivFlags(month, region, flags) {
  await requireEditor();
  const rows = (await readRows(T.IND, month)).filter(r => (r['지역'] || '') === region);
  const hit = rows.find(r => r['유치자'] === '' || r['유치자'] == null);
  if (!hit) throw new Error(region + ' ' + month + ' 개별정산 데이터가 없습니다.');
  let sm = {}; try { sm = JSON.parse(hit['비고'] || '{}'); } catch (_) {}
  Object.keys(flags || {}).forEach(k => sm[k] = flags[k]);
  if (flags && flags.confirmed && !('published' in flags)) sm.published = false;
  hit['비고'] = JSON.stringify(sm); hit['수정일'] = now(); hit['수정자'] = currentUser();
  await replaceRows(T.IND, month, region, rows);
  return getIndiv(month);
}
async function getLocks(month) {
  const out = {};
  (await readRows(T.IND, month)).forEach(r => { if (r['유치자'] !== '' && r['유치자'] != null) return; let sm = {}; try { sm = JSON.parse(r['비고'] || '{}'); } catch (_) {} out[r['지역'] || ''] = !!sm.confirmed; });
  return out;
}
async function saveIndiv(month, region, rows, summary, details) {
  await requireEditor(); checkMonth(month); if (!region) throw new Error('지역이 없습니다.');
  const ts = now(), who = currentUser(); const out = []; let i = 0;
  out.push({ '월': month, '지역': region, '순서': ++i, '유치자': '', '수수료': 0, '비용': 0, '추가기타': 0, '환수차감': 0, '토스비': 0, '전체건': 0, '일반건': 0, '비고': JSON.stringify(summary || {}), '수정일': ts, '수정자': who });
  (rows || []).forEach(r => out.push({ '월': month, '지역': region, '순서': ++i, '유치자': r.emp || '', '수수료': Number(r.fee) || 0, '비용': Number(r.cost) || 0, '추가기타': Number(r.extra) || 0,
    '환수차감': Number(r.refund) || 0, '토스비': Number(r.toss) || 0, '전체건': Number(r.n) || 0, '일반건': Number(r.nIlban) || 0, '비고': r.note || '', '수정일': ts, '수정자': who }));
  await replaceRows(T.IND, month, region, out);
  if (details) {
    let j = 0;
    const d2 = details.map(d => { const o = { '월': month, '지역': region, '순서': ++j }; IND_COLS.forEach((k, idx) => { const v = Array.isArray(d) ? d[idx] : d[k]; o[k] = v == null ? '' : v; }); return o; });
    await replaceRows(T.INDD, month, region, d2);
  }
  return getIndiv(month);
}
async function getIndivDetailsRegion(month, region) {
  await requireEditor();
  return (await readRows(T.INDD, month)).filter(r => (r['지역'] || '') === region).sort(bySeq).map(indDetailObj);
}

/* ───────────────── 전자결재 ───────────────── */
async function getApproval(month) {
  await requireEditor();
  const memos = {};
  (await readRows(T.APPR, month)).sort(bySeq).forEach(r => {
    const g = r['지역'] || ''; memos[g] = memos[g] || { sections: [], updatedAt: '', updatedBy: '' };
    memos[g].sections.push({ key: r['항목'], on: String(r['사용']) !== '0' && String(r['사용']) !== 'false', title: r['제목'] || '', body: r['본문'] || '' });
    if (String(r['수정일'] || '') > String(memos[g].updatedAt || '')) { memos[g].updatedAt = r['수정일'] || ''; memos[g].updatedBy = r['수정자'] || ''; }
  });
  return { month, memos, months: await distinctMonths(T.APPR), indiv: await getIndiv(month), penalty: (await getPenalty(month)).rows, sky: (await getSky(month)).rows, up: (await getUp(month)).rows,
    refund: (await getRefund(month)).rows, occur: (await getOccur(month)).regions };
}
async function saveApproval(month, region, sections) {
  await requireEditor(); checkMonth(month);
  const ts = now(), who = currentUser();
  await replaceRows(T.APPR, month, region, (sections || []).map((x, i) => ({ '월': month, '지역': region, '순서': i + 1, '항목': x.key || '', '사용': x.on ? '1' : '0', '제목': x.title || '', '본문': x.body || '', '수정일': ts, '수정자': who })));
  return getApproval(month);
}

/* ───────────────── 환수완료 ───────────────── */
async function getRefund(month) {
  await requireEditor();
  const all = (await readRows(T.RF, month)).sort(bySeq);
  let summary = null, updatedAt = '', updatedBy = ''; const rows = [];
  all.forEach(r => {
    if (String(r['수정일'] || '') > String(updatedAt)) { updatedAt = r['수정일'] || ''; updatedBy = r['수정자'] || ''; }
    if (r['고객명'] === '' || r['고객명'] == null) { try { summary = JSON.parse(r['비고'] || '{}'); } catch (_) { summary = {}; } return; }
    rows.push({ customer: r['고객명'], svc: r['서비스번호'] || '', open: r['개통일'] || '', dept: r['유치부서'] || '', emp: r['유치자'] || '', collector: r['환수자'] || '', occur: r['발생일'] || '',
      need: Number(r['필요금액']) || 0, paidTotal: Number(r['입금액합']) || 0, done: r['완료일'] || '', payDate: r['입금일'] || '', paid: Number(r['입금액']) || 0, note: r['비고'] || '',
      exAdj: String(r['보정제외']) === '1', exInc: String(r['인센제외']) === '1', reason: r['사유'] || '', cat: r['구분'] || '' });
  });
  return { month, rows, summary, updatedAt, updatedBy, months: await distinctMonths(T.RF) };
}
async function saveRefund(month, rows, summary) {
  await requireEditor(); checkMonth(month);
  const ts = now(), who = currentUser(); const out = []; let i = 0;
  out.push({ '월': month, '순서': ++i, '고객명': '', '서비스번호': '', '개통일': '', '유치부서': '', '유치자': '', '환수자': '', '발생일': '', '필요금액': 0, '입금액합': 0, '완료일': '', '입금일': '', '입금액': 0,
    '비고': JSON.stringify(summary || {}), '보정제외': '', '인센제외': '', '사유': '', '수정일': ts, '수정자': who, '구분': '' });
  (rows || []).forEach(r => out.push({ '월': month, '순서': ++i, '고객명': r.customer || '', '서비스번호': r.svc || '', '개통일': r.open || '', '유치부서': r.dept || '', '유치자': r.emp || '', '환수자': r.collector || '',
    '발생일': r.occur || '', '필요금액': Number(r.need) || 0, '입금액합': Number(r.paidTotal) || 0, '완료일': r.done || '', '입금일': r.payDate || '', '입금액': Number(r.paid) || 0, '비고': r.note || '',
    '보정제외': r.exAdj ? '1' : '', '인센제외': r.exInc ? '1' : '', '사유': r.reason || '', '수정일': ts, '수정자': who, '구분': r.cat || '' }));
  await replaceRows(T.RF, month, null, out);
  return getRefund(month);
}

/* ───────────────── 환수발생 ───────────────── */
async function getOccur(month) {
  await requireEditor();
  const all = (await readRows(T.RO, month)).sort(bySeq);
  const regions = {};
  all.forEach(r => {
    const g = r['지역'] || ''; if (!regions[g]) regions[g] = { rows: [], summary: null, updatedAt: '', updatedBy: '' };
    const R = regions[g];
    if (String(r['수정일'] || '') > String(R.updatedAt || '')) { R.updatedAt = r['수정일'] || ''; R.updatedBy = r['수정자'] || ''; }
    if (r['고객명'] === '' || r['고객명'] == null) { try { R.summary = JSON.parse(r['정산비고'] || '{}'); } catch (_) { R.summary = {}; } return; }
    R.rows.push({ cat: r['구분'] || '', emp: r['유치자'] || '', customer: r['고객명'] || '', product: r['상품명'] || '', option: r['상품옵션'] || '', open: r['개통일'] || '', status: r['개통상태'] || '', memo: r['정산비고'] || '', amount: Number(r['정산금액']) || 0 });
  });
  return { month, regions, months: await distinctMonths(T.RO) };
}
async function saveOccur(month, region, rows, summary) {
  await requireEditor(); checkMonth(month); if (!region) throw new Error('지역이 없습니다.');
  const ts = now(), who = currentUser(); const out = []; let i = 0;
  out.push({ '월': month, '지역': region, '순서': ++i, '구분': '', '유치자': '', '고객명': '', '상품명': '', '상품옵션': '', '개통일': '', '개통상태': '', '정산비고': JSON.stringify(summary || {}), '정산금액': 0, '수정일': ts, '수정자': who });
  (rows || []).forEach(r => out.push({ '월': month, '지역': region, '순서': ++i, '구분': r.cat || '', '유치자': r.emp || '', '고객명': r.customer || '', '상품명': r.product || '', '상품옵션': r.option || '',
    '개통일': r.open || '', '개통상태': r.status || '', '정산비고': r.memo || '', '정산금액': Number(r.amount) || 0, '수정일': ts, '수정자': who }));
  await replaceRows(T.RO, month, region, out);
  return getOccur(month);
}

/* ───────────────── 팀손익 결산 ───────────────── */
async function readClose(month) {
  const all = (await readRows(T.CL, month)).sort(bySeq);
  const out = { month, teams: [], emps: [], summary: null, updatedAt: '', updatedBy: '' };
  all.forEach(r => {
    if (String(r['수정일'] || '') > String(out.updatedAt || '')) { out.updatedAt = r['수정일'] || ''; out.updatedBy = r['수정자'] || ''; }
    const n = k => Number(r[k]) || 0;
    if (r['구분'] === 'summary') { try { out.summary = JSON.parse(r['비고'] || '{}'); } catch (_) { out.summary = {}; } return; }
    const o = { coop: r['협력점'] || '', fee: n('수수료'), cost: n('비용'), refund: n('환수발생'), paid: n('환수입금'), n: n('전체건'), nIlban: n('일반건') };
    if (r['구분'] === 'emp') { o.emp = r['유치자'] || ''; out.emps.push(o); } else out.teams.push(o);
  });
  return out;
}
async function getClose(month) {
  await requireEditor();
  const d = await readClose(month);
  const w = await getWisely(month);
  return Object.assign(d, { months: await distinctMonths(T.CL), indiv: await getIndiv(month), wisely: { rows: w.rows, prices: w.prices }, sky: (await getSky(month)).rows, up: (await getUp(month)).rows,
    penalty: (await getPenalty(month)).rows, refund: (await getRefund(month)).rows, occur: (await getOccur(month)).regions });
}
async function saveClose(month, teams, emps, summary, details) {
  await requireEditor(); checkMonth(month);
  const ts = now(), who = currentUser(); const out = []; let i = 0;
  const row = (kind, o) => ({ '월': month, '구분': kind, '순서': ++i, '협력점': o.coop || '', '유치자': o.emp || '', '수수료': Number(o.fee) || 0, '비용': Number(o.cost) || 0, '환수발생': Number(o.refund) || 0, '환수입금': Number(o.paid) || 0, '전체건': Number(o.n) || 0, '일반건': Number(o.nIlban) || 0, '비고': '', '수정일': ts, '수정자': who });
  out.push(Object.assign(row('summary', {}), { '비고': JSON.stringify(summary || {}) }));
  (teams || []).forEach(t => out.push(row('team', t)));
  (emps || []).forEach(e => out.push(row('emp', e)));
  await replaceRows(T.CL, month, null, out);
  if (details) {
    let j = 0;
    await replaceRows(T.CLD, month, null, details.map(d => { const o = { '월': month, '협력점': d['협력점'] || '', '순서': ++j }; IND_COLS.forEach(k => o[k] = d[k] == null ? '' : d[k]); return o; }));
  }
  return getClose(month);
}
async function getCloseDetail(month, region, emp) {
  await requireEditor();
  const k = normNameGs(emp);
  const file = (await readRows(T.CLD, month)).filter(r => String(r['협력점'] || '').indexOf(region) >= 0 && normNameGs(r['유치자']) === k).sort(bySeq).map(indDetailObj);
  return { file, saved: await getIndivDetails(month, region, emp) };
}

/* ───────────────── 사원 포털 ───────────────── */
async function myMonths(me) {
  const k = normNameGs(me.name); const out = {};
  const all = await readRows(T.IND);
  const sumOf = (m, reg) => { const r = all.find(x => monthKey(x['월']) === m && (x['지역'] || '') === reg && (x['유치자'] === '' || x['유치자'] == null)); if (!r) return null; try { return JSON.parse(r['비고'] || '{}'); } catch (_) { return {}; } };
  all.forEach(r => { const m = monthKey(r['월']); if (!m || !r['유치자']) return;
    const reg = r['지역'] || ''; if (!(normNameGs(r['유치자']) === k || (me.leader && reg === me.region))) return;
    const sm = sumOf(m, reg); if (sm && sm.published) out[m] = reg; });
  return Object.keys(out).sort().reverse().map(m => ({ month: m, region: out[m] }));
}
async function myBonusMonths(me) {
  const set = {};
  (await readRows(T.IND)).forEach(r => { const m = monthKey(r['월']); if (!m || (r['지역'] || '') !== me.region || (r['유치자'] !== '' && r['유치자'] != null)) return; try { if (JSON.parse(r['비고'] || '{}').published) set[m] = 1; } catch (_) {} });
  return Object.keys(set).sort().reverse();
}
async function getMyStatement(month, empName) {
  const me = (await isEditor()) ? null : await currentEmployee();
  if (!me) throw new Error('권한이 없습니다.');
  const k = normNameGs(me.name);
  const all = (await readRows(T.IND, month)).filter(r => r['유치자']);
  let region, rows;
  if (me.leader) { region = me.region; rows = all.filter(r => (r['지역'] || '') === region); }
  else { const mine = all.find(r => normNameGs(r['유치자']) === k); region = mine ? (mine['지역'] || '') : ''; rows = mine ? [mine] : []; }
  if (!rows.length) return { month, found: false, months: await myMonths(me) };
  const summary = (await indSummaryOf(month, region)) || {};
  if (!summary.published) return { month, found: false, months: await myMonths(me) };
  const sel = rows.find(r => normNameGs(r['유치자']) === normNameGs(empName || me.name)) || rows[0];
  const L = await indivLookups(month); const keys = rows.map(r => normNameGs(r['유치자']));
  const pickAll = o => { const out = {}; keys.forEach(x => { if (o && o[x]) out[x] = o[x]; }); return out; };
  return { month, found: true, region, me, leader: !!me.leader, summary: { rate: summary.rate, extras: summary.extras || [] },
    rows: rows.map(indRowObj), row: indRowObj(sel),
    lookups: { bonus1: pickAll(L.bonus1), bonus2: pickAll(L.bonus2), wisely: pickAll(L.wisely), refundAdj: pickAll(L.refundAdj) },
    details: await getIndivDetails(month, region, sel['유치자']), months: await myMonths(me) };
}
async function getMyBonus(month) {
  const me = (await isEditor()) ? null : await currentEmployee();
  if (!me) throw new Error('권한이 없습니다.');
  const k = normNameGs(me.name), region = me.region;
  const mine = r => me.leader || normNameGs(r['유치자']) === k;
  const pub = !!(((await indSummaryOf(month, region)) || {}).published);
  const b1 = pub ? (await readRows(T.BONUS, month)).filter(r => (r['지역'] || '') === region && r['고객명'] && r['상태'] === '대상' && mine(r))
    .map(r => ({ kind: r['종류'], emp: r['유치자'], customer: r['고객명'], product: r['상품'], option: r['옵션'], route: r['접수경로'], open: r['개통일'], price: Number(r['단가']) || 0 })) : null;
  const b2 = pub ? (await readRows(T.ADJ, month)).filter(r => (r['지역'] || '') === region && r['고객명'] && r['상태'] === '대상' && mine(r))
    .map(r => ({ rule: r['규칙'], emp: r['유치자'], customer: r['고객명'], n: Number(r['건수']) || 0, amount: Number(r['정산금액']) || 0, need: Number(r['필요금액']) || 0, adj: Number(r['보정금액']) || 0 })) : null;
  return { month, region, leader: !!me.leader, bonus1: b1, bonus2: b2 };
}
async function getMyAll(month) {
  const me = (await isEditor()) ? null : await currentEmployee();
  if (!me) throw new Error('권한이 없습니다.');
  return { month, statement: await getMyStatement(month, null), bonus: await getMyBonus(month), criteria: me.leader ? await getMyCriteria(month) : null };
}

/* ───────────────── 디스패치 ───────────────── */
const PORTAL_FNS = ['getInit', 'getMyStatement', 'getIndivDetails', 'getMyBonus', 'getMyCriteria', 'getMyAll'];
const ADMIN_FNS = PORTAL_FNS.concat(['getClose', 'saveClose', 'getCloseDetail', 'listMonths', 'getMonth', 'saveMonth', 'createMonth', 'deleteMonth', 'listImages', 'uploadImage', 'getImageData', 'deleteImage',
  'getSettings', 'saveSettings', 'getPenalty', 'savePenalty', 'getWisely', 'saveWisely', 'getSky', 'saveSky', 'getUp', 'saveUp', 'getAdj', 'saveAdj', 'getBonus', 'saveBonus', 'getIndiv', 'getIndivDetailsRegion', 'saveIndiv',
  'getApproval', 'saveApproval', 'getRefund', 'saveRefund', 'getOccur', 'saveOccur', 'setIndivFlags', 'getLocks']);
const FN = { getInit, listMonths, getMonth, getMyCriteria, saveMonth, createMonth, deleteMonth, listImages, uploadImage, getImageData, deleteImage, getSettings, saveSettings,
  getPenalty, savePenalty, getWisely, saveWisely, getSky, saveSky, getUp, saveUp, getAdj, saveAdj, getBonus, saveBonus, getIndiv, getIndivDetails, getIndivDetailsRegion, saveIndiv, setIndivFlags, getLocks,
  getApproval, saveApproval, getRefund, saveRefund, getOccur, saveOccur, getClose, saveClose, getCloseDetail, getMyStatement, getMyBonus, getMyAll };

export function handle(fn, args, { email, db }) {
  return als.run({ email: String(email || '').toLowerCase(), db, memo: {} }, async () => {
    const allowed = (await isEditor()) ? ADMIN_FNS : PORTAL_FNS;
    if (!allowed.includes(fn) || typeof FN[fn] !== 'function') throw new Error('허용되지 않은 요청: ' + fn);
    return await FN[fn].apply(null, Array.isArray(args) ? args : []);
  });
}
