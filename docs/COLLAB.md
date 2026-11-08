# 협업 현황 — Claude · Codex(GPT)

> 갱신: 2026-11-09 · 이 문서는 사람(프로젝트 주인)과 두 AI 가 같이 본다. 작업을 시작하기 전에 읽고, 맡은 작업의 상태를 여기 고친다.

## 1. 한눈에

| 항목 | 지금 |
|---|---|
| 최신 통합본 | `claude/gracious-tesla-twxvix` 브랜치 (모든 작업이 합쳐진 곳. 사실상 main) |
| 들어 있는 것 | v0.3 — 정복전 · 방어전, 조향 이동, 전투 추정 AI, 영토 · 발광 그래픽, 합성 사운드, 확대 카메라 · 미니맵, 선택형 Codex 디자인, 대화창 접근성 |
| 검사 | tsc · vitest 129 통과 · 빌드 · 브라우저 스모크(두 디자인 × 6 화면) 통과 |
| 설계 문서 | [GAME_DESIGN.md](GAME_DESIGN.md) (규칙 · 수치 · 검증 결과), Codex 쪽 계획은 [CODEX_PLAN.md](CODEX_PLAN.md) |

## 2. 브랜치 규칙

1. **각자 자기 브랜치에서 작업한다.** Claude 는 `claude/...`, Codex 는 `codex/...`. 통합 브랜치에 직접 푸시하는 것은 Claude 의 통합 작업뿐이다.
2. **시작 전에 통합 브랜치 최신을 받는다.** `git fetch` 후 `origin/claude/gracious-tesla-twxvix` 에서 시작하거나 그것을 합친다. 옛 기준에서 오래 작업할수록 충돌이 커진다.
3. **작게, 자주 합친다.** 기능 하나가 끝나면 브랜치를 푸시한다. Claude 가 통합 브랜치로 합치고 검사한 뒤 결과를 이 문서에 적는다.
4. **같은 일을 둘이 하지 않는다.** 시작할 때 아래 작업 보드의 상태를 `진행 중` 으로 바꿔 커밋한다. 보드에 없는 버그를 발견하면 먼저 보드에 적는다.
5. 사람이 원하면 통합 브랜치를 `main` 으로 바꾼다 (지금은 이름만 다를 뿐 역할은 같다).

## 3. 담당 영역

겹치지 않게 파일 단위로 나눈다. 남의 영역을 고쳐야 하면 작게 고치고 커밋 메시지에 이유를 적는다.

| 영역 | 담당 | 파일 |
|---|---|---|
| 규칙 · 시뮬레이션 · 밸런스 | Claude | `src/sim/*` (world · orders · waves · mapgen · match), `src/config.ts` 의 CONFIG · DEFENSE |
| AI | Claude | `src/sim/ai.ts`, `src/config.ts` 의 AI_PROFILES, `tests/ai.test.ts`, `tests/balance.harness.test.ts` |
| 그래픽 · 사운드 · 입력 · 카메라 | Claude | `src/render/*`, `src/audio/*`, `src/input/*`, `src/ui/alerts.ts` |
| 메뉴 디자인 · 접근성 | Codex | `src/design/*`, `src/ui/dialogs.ts`, `src/ui/launch.ts`, `docs/DESIGN_COMPARISON.md`, `docs/design/*` |
| 브라우저 회귀 검사 | Codex | `scripts/browser-smoke.mjs` |
| 튜토리얼 · 리플레이 UI (새로) | Codex | 새 파일 `src/ui/tutorial*`, `src/replay*` 등 |
| 설계 문서 | Claude (규칙 · 수치), Codex (자기 계획) | `docs/GAME_DESIGN.md` / `docs/CODEX_PLAN.md` |

**함께 쓰는 파일 (충돌이 잘 나는 곳)**: `src/main.ts`, `src/game.ts`, `index.html`, `src/style.css`, `src/ui/hud.ts`.
여기를 고칠 때는 필요한 줄만 바꾸고, 보드의 작업 항목에 "main.ts 수정" 처럼 적는다.

## 4. 작업 보드

상태: `대기` · `진행 중` · `검토 대기` · `완료`

### 지금 할 일

| # | 작업 | 담당 | 상태 | 메모 |
|---|---|---|---|---|
| X1 | 첫 판 튜토리얼 3개 (생산 · 선택 → 빈 행성 돌파 → 두꺼운 수비대 포위 후 돌파) | Codex | 대기 | CODEX_PLAN §1. 판정에 `estimateBattle` 를 쓰고 싶으면 Claude 에게 |
| X2 | 명령 기록 · 리플레이 | Codex | 대기 | CODEX_PLAN §2. 재생은 같은 시드 + 같은 명령을 다시 돌리면 된다 (결정론). 저장 · 이어 하기까지 하려면 World 의 이동 상태(WeakMap) · AI 작전 · 웨이브 상태 직렬화가 필요 → 그 부분은 Claude |
| C1 | 그래픽 품질 관리자: 30Hz 로 묶인 기기에서 '하'에 갇힘, 메뉴 · 도움말 뒤 프레임까지 판단에 섞임 | Claude | 진행 중 | 리뷰 F2 · F9. 내렸는데 프레임이 안 빨라지면 되돌리는 방식으로 |
| C2 | 발광: 확대했을 때 큰 섬광이 각진 사각형으로 보임 | Claude | 진행 중 | 리뷰 F1 |
| C3 | 고해상도 화면에서 2.5배 넘게 확대하면 행성 캐시를 안 써서 느려짐 | Claude | 진행 중 | 리뷰 F3 |
| C4 | 점령 색 번짐이 끝날 때 밝기가 한 번 튐 | Claude | 진행 중 | 리뷰 F4 |
| C5 | 1,000기 넘는 한 번의 명령이 휴대폰에서 프레임을 끊음 (2-opt) | Claude | 진행 중 | 리뷰 F6 |
| C6 | 공간 격자 재구성이 틱 비용의 17~24% | Claude | 대기 | 이동 작업 메모 |
| H1 | 사람 플레이테스트: 보통 · 어려움 난이도 체감, 휴대폰 실기기 프레임 | 사람 | 대기 | 플레이 링크에서. 어려움은 스크립트 상대로 매우 강하다 (18/20) |

### 다음 (위가 끝난 뒤)

| 작업 | 담당 | 메모 |
|---|---|---|
| 전술 실험실 (같은 전투를 돌파 / 포위로 나란히 비교) | Codex 주도, 시뮬레이션은 Claude | CODEX_PLAN §3 |
| 행성 특성 하나 (생산 특화 또는 방어 특화) | Claude (규칙 · AI · 그래픽), Codex (설명 UI) | 튜토리얼과 실험실을 해 본 뒤 |
| 모바일 '선 긋기' 모드 · 부대 버튼 | 미정 | |

### 최근 완료

| 작업 | 누가 | 커밋 |
|---|---|---|
| 대기권 바로 바깥 슬롯에서 영영 도착 못 하던 병력 | Claude | `4a5d904` |
| 메뉴 배경 관전 판이 끝나면 굳어 버리던 것 | Claude | `4a5d904` |
| 새 이동에 맞춘 AI 도착 시각 모형 (견제 · 물러나기) | Claude · Codex 둘 다 고침 → Claude 쪽 채택 (아래 6) | `31fdb31` |
| 반응형 Codex UI · 대화창 접근성 · 스모크 테스트 확장 | Codex | `a393045` |
| 조향 이동 · 전투 추정 AI · 영토/발광 그래픽 | Claude | `c3121fa` 까지 |
| 다자전 패배 처리 · 점령 판정 · 대형 경계, 선택형 Codex 디자인 | Codex | `592dbe9` 에서 통합 |

## 5. 합칠 때 검사

모두 통과해야 통합 브랜치에 들어간다.

```bash
npx tsc --noEmit
npx vitest run                     # 129 개 (하네스 6 개는 생략됨)
npx vite build
CHROMIUM_PATH=<chromium 경로> npm run test:browser
# 시뮬레이션 · AI · 밸런스를 바꿨다면 추가로
BALANCE=conquest,aivai,defense npx vitest run tests/balance.harness.test.ts --reporter=verbose
```

## 6. 충돌을 정리하는 원칙

1. **같은 문제를 둘 다 고쳤다면** 더 완전하고 측정된 쪽을 택하고, 다른 쪽의 착상이 그 안에 들어 있는지 확인한 뒤 커밋 메시지에 이유를 남긴다.
   예: AI 견제 · 물러나기 타이밍을 Codex(`bdf3e89`, 17줄)와 Claude(`a3794e5`, 이동 모형 + 추정기 재보정 + 테스트)가 따로 고쳤다.
   Claude 쪽이 Codex 의 두 착상(실제 병력 위치로 도착 재기, 대기권 진입 전 재평가)을 포함하고 측정까지 있어 그쪽을 택했다 (`31fdb31`).
2. **테스트 기준을 낮춰 통과시키지 않는다.** 기준이 옛 동작을 담고 있었다는 근거가 있을 때만 바꾸고, 그 근거를 적는다.
3. **밸런스 수치를 바꾸면** 하네스 결과(바꾸기 전 → 뒤)를 같이 적는다. 수치만 바뀌고 근거가 없으면 되돌린다.
4. 합쳐서 충돌이 없어도 동작이 깨질 수 있다 (예: 이동이 바뀌어 AI 타이밍 테스트 2개가 실패). 그래서 합친 뒤 5 의 검사를 반드시 다시 돌린다.

## 7. 사람이 결정하거나 해 줄 일

- **플레이 해 보기**: 난이도(특히 보통이 처음 하는 사람에게 너무 세지 않은지)와 휴대폰에서의 끊김. 이것만은 AI 가 측정할 수 없다.
- **기본 디자인**: 기존 / Codex 중 무엇을 기본으로 할지 (지금은 메뉴의 링크로 비교 가능).
- **`main` 브랜치**: 통합 브랜치 이름을 `main` 으로 바꿀지.
- **GPT 의 GitHub 권한**: GPT 에서 PR 을 만들 때 403 이 났다면, GitHub → Settings → Applications 에서 ChatGPT(Codex) 앱의 저장소 접근에 이 저장소를 넣고 Contents · Pull requests 를 Read and write 로.
