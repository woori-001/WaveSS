# 정산 관리 (settle) — Supabase 버전

구글시트 + Apps Script 로 돌아가던 "정산 관리" 웹앱을 **정적 웹 + Supabase** 로 옮긴 버전입니다.

```
docs/settle/                 ← 웹 화면 (GitHub Pages 로 서비스)
  index.html                 ← 화면 전체 (기존 Index.html + 로그인)
  config.js                  ← Supabase URL / anon key (공개 가능)
supabase/
  migrations/…_settle_schema.sql   ← 테이블 23개 + RLS + settle_replace 함수 + 이미지 버킷
  functions/settle-api/      ← Edge Function (기존 Code.gs 를 이식한 서버 로직)
    index.ts                 ← 로그인 확인 → core.js 호출
    core.js                  ← 모든 데이터 읽기/쓰기/권한
settle/
  README.md                  ← 이 문서
  tools/Migrate.gs           ← 구글시트 → Supabase 일회성 이전 스크립트
```

## 구조

| 역할 | 전 | 후 |
|---|---|---|
| 화면 | Apps Script HtmlService | GitHub Pages 정적 파일 (`docs/settle/index.html`) |
| 로그인 | 구글 계정 (Apps Script 가 넘겨줌) + 포털 이중 배포 | Supabase Auth (Google 로그인 또는 이메일 인증코드) — 앱 1개, URL 1개 |
| 서버 로직 | Code.gs | Edge Function `settle-api` (`core.js`) |
| 저장소 | 구글시트 탭 23개 | Postgres 테이블 `settle_*` 23개 (행 = `data` jsonb, 열 이름은 시트와 동일) |
| 이미지 | 드라이브 폴더 | Storage 버킷 `settle-images` (비공개, 서명 URL) |
| 편집자 목록 | 설정 시트 `편집자` 행 | 설정 메뉴 > 관리 > 편집자 (같은 데이터가 `settle_config` 에 저장) |

권한 판단은 전부 Edge Function 안에서 **접속 이메일 기준**으로 합니다 (편집자 → 전체, 사원 → 본인 정산서, 팀장 → 지역 전체).
테이블에는 RLS 가 켜져 있고 정책이 없어서 `anon`/`authenticated` 키로는 아무 것도 읽고 쓸 수 없고, service_role(Edge Function)만 접근합니다. 같은 프로젝트의 다른 앱(sky_, duty_ …)과는 테이블 접두사로 분리됩니다.

## 1. Supabase (이미 적용됨)

- 테이블/함수/버킷: `supabase/migrations/20261008000000_settle_schema.sql` — **woori-001's Project 에 적용 완료**
- Edge Function `settle-api` — **배포 완료 (v1)**
- 초기값: `settle_config` 에 편집자 3명(w33439067@gmail.com, w01099276440@gmail.com, rlaekaals@010king.com), 앱이름, 팀 3개

코드를 고친 뒤 다시 배포하려면 (Supabase CLI):
```bash
npm i -g supabase
supabase login
supabase link --project-ref omdyyvqkxxigilxjysbz
supabase functions deploy settle-api        # supabase/functions/settle-api 배포
supabase db push                            # (스키마를 바꿨을 때만)
```

### 로그인 설정 (대시보드에서 한 번)
Supabase 대시보드 → **Authentication**
1. **URL Configuration**
   - Site URL: `https://woori-001.github.io/WaveSS/settle/`
   - Redirect URLs 에 같은 주소 추가
2. **Providers → Google** 켜기 (권장)
   - Google Cloud Console → API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID(웹) 생성
   - 승인된 리디렉션 URI: `https://omdyyvqkxxigilxjysbz.supabase.co/auth/v1/callback`
   - 클라이언트 ID / 보안 비밀을 Supabase Google provider 에 입력
3. 이메일 인증코드(OTP) 는 기본으로 켜져 있음. Supabase 기본 메일은 **시간당 몇 통**으로 제한되므로 사원 전체가 쓰려면 Google 로그인을 켜거나, Authentication → SMTP 에 회사 메일(SMTP)을 연결하세요.
   - Email 템플릿 "Magic Link" 본문에 `{{ .Token }}` 이 들어 있어야 6자리 코드가 메일에 찍힙니다.

## 2. GitHub Pages

1. 이 저장소에 푸시
2. Settings → Pages → Source: **Deploy from a branch**, Branch: `main` / **`/docs`**
3. 1~2분 뒤 `https://woori-001.github.io/WaveSS/settle/` 로 접속

`docs/settle/config.js` 의 URL/anon key 는 이미 woori-001's Project 값으로 들어 있습니다.

## 3. 구글시트 데이터 이전 (한 번만)

1. 기존 정산관리 Apps Script 프로젝트를 열고 파일 추가 → `settle/tools/Migrate.gs` 내용 붙여넣기 (기존 Code.gs 는 그대로)
2. 프로젝트 설정 → 스크립트 속성
   - `SUPABASE_URL` = `https://omdyyvqkxxigilxjysbz.supabase.co`
   - `SUPABASE_SERVICE_KEY` = 대시보드 → Project Settings → API → `service_role` 키 (**절대 외부에 공유 금지**)
3. 편집기에서 `migrateToSupabase` 실행 → 실행 로그에 시트별 행 수
4. 이미지도 옮기려면 `migrateImagesToSupabase` 실행 (드라이브 → Storage)
5. 끝나면 스크립트 속성에서 `SUPABASE_SERVICE_KEY` 삭제

이전은 **테이블을 비우고 다시 넣는** 방식이라 여러 번 실행해도 됩니다. 설정 시트의 편집자/앱이름도 그대로 넘어옵니다 (위 초기값을 덮어씀).

## 4. 사용

- 접속 → Google 로그인 (또는 이메일 → 코드 입력)
- 편집자 이메일이면 관리자 화면, 설정 > 사원에 등록된 이메일이면 사원/팀장 화면, 둘 다 아니면 "접근 권한 없음"
- 왼쪽 아래 이름을 누르면 로그아웃
- 편집자 추가/삭제: 설정 → 편집 → 관리 → 편집자 (쉼표 구분). 본인은 뺄 수 없음

## 5. 자주 묻는 것

- **anon key 가 코드에 있어도 되나?** 네. 공개용 키이고, 테이블은 RLS 로 막혀 있어 키만으로는 아무 것도 못 합니다.
- **느리면?** 첫 호출은 Edge Function 콜드스타트(1~2초). 그 뒤는 월당 1~2회 호출이라 빠릅니다.
- **데이터는 어디서 보나?** Supabase 대시보드 → Table Editor → `settle_*`. `data` 열에 시트 열 이름 그대로 들어 있습니다.
- **시트는 어떻게?** 백업으로 그대로 두세요. 앱은 더 이상 시트를 읽지 않습니다.
