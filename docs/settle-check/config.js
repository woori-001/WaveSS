// Supabase 연결 정보 (anon key 는 공개해도 되는 키입니다 — 데이터 접근은 RLS/Edge Function 이 막습니다)
// 검수용 웹: 서버 함수 settle-api-check (settle_check_* 테이블만 사용)
window.SETTLE_CONFIG = {
  fn: 'settle-api-check',
  url: 'https://omdyyvqkxxigilxjysbz.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tZHl5dnFreHhpZ2lseGp5c2J6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzMTE4NTMsImV4cCI6MjEwNjg4Nzg1M30.4UHcdPtZc-ft3FyAzwkSzX4EXZj-0yXAoGZyMUNNHeQ',
};
