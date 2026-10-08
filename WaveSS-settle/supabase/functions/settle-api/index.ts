// 정산 관리 API — Supabase Edge Function
// 요청: POST { fn, args }  (Authorization: Bearer <사용자 access_token>)
// 응답: { ok: true, result } | { ok: false, error }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle } from './core.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  try {
    const auth = req.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) return json({ ok: false, error: '로그인이 필요합니다.' }, 401);
    // 접속자 확인 (사용자 토큰으로)
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user }, error: uerr } = await userClient.auth.getUser();
    if (uerr || !user || !user.email) return json({ ok: false, error: '로그인 정보를 확인할 수 없습니다. 다시 로그인하세요.' }, 401);
    // 데이터 접근은 service_role (RLS 우회) — 권한 판단은 core.js 에서 이메일 기준
    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const result = await handle(String(body.fn || ''), body.args, { email: user.email, db });
    return json({ ok: true, result });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) });
  }
});
