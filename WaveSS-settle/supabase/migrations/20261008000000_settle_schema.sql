-- ─────────────────────────────────────────────────────────────────────────────
-- 정산 관리 (settle_*) 스키마
--  · 구글시트 탭 1개 = 테이블 1개. 행 내용은 data(jsonb)에 시트 열 이름(한글) 그대로 보관
--  · month / region / seq 는 data 에서 자동 생성되는 열 (조회·정렬용)
--  · RLS: 정책 없음 = anon / authenticated 모두 접근 불가. Edge Function(service_role)만 접근
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'config','months','items','memos','images',
    'penalty','teams','employees',
    'wisely','wisely_detail','sky','sky_detail','upsell','upsell_detail',
    'adj','bonus','indiv','indiv_detail','approval','refund','occur','close','close_detail'
  ] loop
    execute format($f$
      create table if not exists public.settle_%1$s (
        id         bigint generated always as identity primary key,
        data       jsonb  not null default '{}'::jsonb,
        month      text   generated always as (nullif(data->>'월', '')) stored,
        region     text   generated always as (nullif(data->>'지역', '')) stored,
        seq        integer generated always as (nullif(regexp_replace(coalesce(data->>'순서',''), '[^0-9]', '', 'g'), '')::integer) stored,
        updated_at timestamptz not null default now()
      )$f$, t);
    execute format('create index if not exists settle_%1$s_month_idx on public.settle_%1$s (month, region, seq)', t);
    execute format('alter table public.settle_%1$s enable row level security', t);
    execute format('revoke all on table public.settle_%1$s from anon, authenticated', t);
  end loop;
end $$;

comment on table public.settle_config        is '정산관리 · 설정 (키/값: 편집자, 앱이름 …)';
comment on table public.settle_months        is '정산관리 · 정산기준 월 목록';
comment on table public.settle_items         is '정산관리 · 정산기준 항목';
comment on table public.settle_memos         is '정산관리 · 정산기준 특이사항';
comment on table public.settle_images        is '정산관리 · 보관 이미지 목록 (파일은 storage: settle-images)';
comment on table public.settle_penalty       is '정산관리 · 채증 패널티';
comment on table public.settle_teams         is '정산관리 · 팀';
comment on table public.settle_employees     is '정산관리 · 사원 (이메일로 로그인 매칭)';
comment on table public.settle_wisely        is '정산관리 · 와이즐리 정산';
comment on table public.settle_wisely_detail is '정산관리 · 와이즐리 상세';
comment on table public.settle_sky           is '정산관리 · 스카이유심';
comment on table public.settle_sky_detail    is '정산관리 · 스카이유심 상세';
comment on table public.settle_upsell        is '정산관리 · 업셀링';
comment on table public.settle_upsell_detail is '정산관리 · 업셀링 상세';
comment on table public.settle_adj           is '정산관리 · 추가매출2 (보정)';
comment on table public.settle_bonus         is '정산관리 · 추가매출1 (건당)';
comment on table public.settle_indiv         is '정산관리 · 개별정산서 (유치자별 집계 + 요약행)';
comment on table public.settle_indiv_detail  is '정산관리 · 개별정산서 고객별 상세';
comment on table public.settle_approval      is '정산관리 · 전자결재 문구';
comment on table public.settle_refund        is '정산관리 · 환수완료';
comment on table public.settle_occur         is '정산관리 · 환수발생';
comment on table public.settle_close         is '정산관리 · 팀손익 결산';
comment on table public.settle_close_detail  is '정산관리 · 팀손익 결산 고객별 상세';

-- 월/지역 범위를 지우고 새 행을 넣는 원자적 교체 (Edge Function 전용)
create or replace function public.settle_replace(p_table text, p_month text, p_region text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if p_table !~ '^[a-z_]+$' then raise exception 'invalid table %', p_table; end if;
  execute format('delete from public.settle_%I where ($1 is null or month = $1) and ($2 is null or region = $2)', p_table)
    using p_month, p_region;
  execute format('insert into public.settle_%I (data) select value from jsonb_array_elements($1)', p_table)
    using coalesce(p_rows, '[]'::jsonb);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.settle_replace(text, text, text, jsonb) from public, anon, authenticated;

-- 이미지 저장소 (비공개: 서명 URL로만 열람)
insert into storage.buckets (id, name, public, file_size_limit)
values ('settle-images', 'settle-images', false, 10485760)
on conflict (id) do nothing;
