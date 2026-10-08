/**
 * 구글시트 → Supabase 일회성 이전 스크립트
 * 사용법
 *  1) 기존 정산관리 Apps Script 프로젝트에 이 파일을 추가 (Code.gs 는 그대로 둠)
 *  2) 프로젝트 설정 > 스크립트 속성에 아래 2개 추가
 *       SUPABASE_URL          = https://omdyyvqkxxigilxjysbz.supabase.co
 *       SUPABASE_SERVICE_KEY  = (Supabase 대시보드 > Project Settings > API > service_role)   ※ 절대 외부 공유 금지
 *  3) 편집기에서 migrateToSupabase 실행 (승인 요청 수락) → 로그에 결과
 *  4) 끝나면 스크립트 속성에서 SUPABASE_SERVICE_KEY 삭제
 */
const SB_TABLE = {
  '설정': 'config', '기준_월목록': 'months', '기준_항목': 'items', '기준_메모': 'memos', '기준_이미지': 'images',
  '패널티': 'penalty', '팀': 'teams', '사원': 'employees', '와이즐리': 'wisely', '와이즐리_상세': 'wisely_detail',
  '스카이유심': 'sky', '스카이유심_상세': 'sky_detail', '업셀링': 'upsell', '업셀링_상세': 'upsell_detail',
  '매출보정': 'adj', '추가매출': 'bonus', '개별정산': 'indiv', '개별정산_상세': 'indiv_detail', '전자결재': 'approval',
  '환수완료': 'refund', '환수발생': 'occur', '팀손익결산': 'close', '팀손익결산_상세': 'close_detail',
};
function sbEnv_() {
  const p = PropertiesService.getScriptProperties();
  const url = p.getProperty('SUPABASE_URL'), key = p.getProperty('SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('스크립트 속성 SUPABASE_URL / SUPABASE_SERVICE_KEY 를 먼저 넣으세요.');
  return { url: url.replace(/\/$/, ''), key };
}
function sbFetch_(path, method, payload, extraHeaders) {
  const { url, key } = sbEnv_();
  const res = UrlFetchApp.fetch(url + path, {
    method, muteHttpExceptions: true, contentType: 'application/json',
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' }, extraHeaders || {}),
    payload: payload == null ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });
  if (res.getResponseCode() >= 300) throw new Error(method + ' ' + path + ' → ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  return res;
}
function migrateToSupabase() {
  cacheClear();
  const log = [];
  Object.keys(SB_TABLE).forEach(sheetName => {
    const table = 'settle_' + SB_TABLE[sheetName];
    const rows = readRows(sheetName);            // Code.gs 의 readRows: 시트 열 이름 그대로의 객체 (날짜는 문자열)
    // 기존 행 비우기 (해당 테이블 전체)
    sbFetch_('/rest/v1/' + table + '?id=gt.0', 'delete');
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map(r => ({ data: r }));
      sbFetch_('/rest/v1/' + table, 'post', chunk);
    }
    log.push(sheetName + ' → ' + table + ' ' + rows.length + '행');
    Logger.log(log[log.length - 1]);
  });
  Logger.log('데이터 이전 완료\n' + log.join('\n'));
  return log.join('\n');
}
/** 드라이브 보관 이미지 → Supabase Storage (settle-images). 이미지가 많으면 몇 분 걸림. 데이터 이전 뒤 실행 */
function migrateImagesToSupabase() {
  const { url, key } = sbEnv_();
  const rows = readRows('기준_이미지');
  const out = []; let ok = 0, fail = 0;
  rows.forEach(r => {
    const month = monthKey(r['월']), name = String(r['파일명'] || 'image.png'), id = String(r['드라이브ID'] || '');
    const row = { '월': month, '파일명': name, '파일경로': '', '업로드일': r['업로드일'] || '', '업로더': r['업로더'] || '' };
    try {
      const blob = DriveApp.getFileById(id).getBlob();
      const path = month + '/' + Date.now() + '_' + name.replace(/[\/\\?#%]/g, '_');
      const res = UrlFetchApp.fetch(url + '/storage/v1/object/settle-images/' + encodeURI(path), {
        method: 'post', muteHttpExceptions: true, contentType: blob.getContentType() || 'image/png',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'x-upsert': 'true' }, payload: blob.getBytes(),
      });
      if (res.getResponseCode() >= 300) throw new Error(res.getContentText().slice(0, 200));
      row['파일경로'] = path; ok++;
    } catch (e) { fail++; Logger.log('실패 ' + name + ': ' + e.message); }
    if (row['파일경로']) out.push({ data: row });
  });
  sbFetch_('/rest/v1/settle_images?id=gt.0', 'delete');
  for (let i = 0; i < out.length; i += 200) sbFetch_('/rest/v1/settle_images', 'post', out.slice(i, i + 200));
  const msg = '이미지 이전: 성공 ' + ok + ' / 실패 ' + fail;
  Logger.log(msg); return msg;
}
