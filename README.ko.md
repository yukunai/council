<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**가벼운 멀티 모델 워크플로 데스크톱 앱.**
서로 다른 LLM을 파이프라인으로 연결해 각 단계가 하나의 작업만 맡고, 한 단계의 출력이 다음 단계로 이어집니다.

[简体中文](./README.zh.md) · [English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [日本語](./README.ja.md) · 한국어 · [Tiếng Việt](./README.vi.md) · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · vanilla TypeScript · 프런트엔드 프레임워크 없음

</div>

---

## 무엇인가

`council`은 여러 모델을 하나의 선형 **파이프라인**으로 엮을 수 있게 해 줍니다. 각 단계는 자체
모델(호스팅 API, 또는 Claude Code / Codex 같은 로컬 CLI)을 선택해 한 가지 일만 합니다 — 초안 작성, 수정,
사실 확인, 다듬기 — 그리고 그 출력을 다음 단계로 넘깁니다. 또한 완성된 글 + 소셜 게시물을 한 번에
생성하는 단발성 **단일 글** 모드(GEO)도 있으며, 선택적으로 인라인 이미지 생성을 함께 쓸 수 있습니다.

모든 것이 네이티브 데스크톱 앱으로 로컬에서 실행됩니다. **API 키는 오직 브라우저의
localStorage에만 저장됩니다** — 설정한 공급자 엔드포인트 외에는 어디로도 전송되지 않습니다.

## 기능

- **텍스트 파이프라인** — 여러 단계, 각 단계마다 고유한 모델과 지시문. 자리표시자로 상위 단계의
  출력을 참조하세요: `{{input}}`(초기 입력), `{{prev}}`(이전 단계), `{{1}}` `{{2}}` …(N번째 단계).
- **모델 마켓** — DeepSeek, OpenAI, Gemini, Qwen, Kimi, GLM, xAI Grok, Mistral,
  Volcengine Doubao, Ollama, MiniMax용 프리셋. OpenAI 호환 `/chat/completions` 엔드포인트라면
  공급자를 추가하는 것만으로 모두 작동합니다.
- **로컬 CLI 워커** — 범용 `cli_run`(프로그램 + 인자 + 프롬프트)을 통해 로컬 에이전트(Claude Code,
  Codex, Gemini CLI, Grok CLI)를 파이프라인 단계로 구동합니다.
- **스킬 라이브러리** — `~/.council/skills`에 있는 재사용 가능한 `SKILL.md` 프롬프트로, 단계별로 첨부할 수 있습니다.
  로컬 파일/폴더에서 가져오거나, git 저장소와 동기화(다운로드 / 업로드)할 수 있습니다.
- **단일 글(GEO) 모드** — 독립형 생성기: 제목/주제, 선택적 경로/장소,
  10가지 문체, 길이 슬라이더, 원본 자료나 참조 URL을 입력, 선택적 인라인
  이미지. 편집 가능한 글 + 짧은 소셜 게시물을 출력하며, 복사하거나 Markdown으로 내보낼 수 있습니다.
- **이미지 생성** — OpenAI 이미지 방식 엔드포인트(예: Volcengine Seedream)를 통한 텍스트-이미지 변환,
  또는 로컬 CLI 워커를 통한 SVG.
- **비디오 생성** — 비동기 텍스트-비디오 변환(Volcengine Ark / Seedance), 결과 카드에 렌더링됩니다.
- **이름 있는 워크플로** — 전체 파이프라인을 파일로 저장 / 불러오기 / 삭제.

## 실행하기

요구 사항: [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/)(stable), 그리고 사용 중인 OS에 맞는
[Tauri 2 사전 요구 사항](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## 사용법

1. 상단 바에서 **厂商 / 命令 / Key**(공급자 / 명령 / 키)를 열고 API 키를 붙여 넣으세요.
   DeepSeek 공급자가 기본 설정되어 있으니 키만 추가하면 됩니다. 다른 OpenAI 호환 서비스의 경우
   클릭해 공급자를 추가하고 `/chat/completions`까지 포함한 엔드포인트를 설정하세요.
2. 왼쪽 패널에서 파이프라인을 구성하세요: 각 단계는 모델(또는 로컬 CLI)과 지시문을 선택합니다.
3. 지시문에서 자리표시자를 사용해 상위 단계의 출력을 참조하세요:
   - `{{input}}` — 맨 위의 초기 입력
   - `{{prev}}` — 이전 단계의 출력
   - `{{1}}` `{{2}}` … — N번째 단계의 출력
4. **▶ 运行 (Run)**을 클릭하세요. 단계가 위에서 아래로 실행되며 오른쪽 결과 패널로 스트리밍됩니다.
5. 단발성 GEO 생성기를 쓰려면 상단 바에서 **单篇 (Single-article)**로 전환하세요.

## 아키텍처

Rust 백엔드(`src-tauri/src/lib.rs`)는 몇 가지 Tauri 명령을 노출하고, vanilla-TS
프런트엔드가 파이프라인을 조율하며 각 단계를 스트리밍합니다.

| Command | 용도 |
| --- | --- |
| `chat_stream` | OpenAI 호환 `/chat/completions`(SSE), Tauri Channel을 통해 델타를 스트리밍 |
| `cli_run` | 로컬 CLI 워커 실행(프로그램 + 고정 인자 + 마지막 argv로서의 프롬프트) |
| `fetch_url` | 웹 페이지를 가져와 읽기 가능한 텍스트를 추출(참조 URL 입력용) |
| `image_generate` | 텍스트-이미지 변환(OpenAI 이미지 방식, 이미지 URL 반환) |
| `video_generate` | 비동기 텍스트-비디오 작업 API(제출 + 폴링), 비디오 URL 반환 |
| `*_workflow` / `*_skill` | 워크플로 및 스킬 저장 / 불러오기 / 목록 / 삭제, 스킬의 git 다운로드 / 업로드 |

- **스트리밍**: HTTP 워커와 CLI 워커 모두 Tauri `Channel<StreamEvent>`를 통해 증분 텍스트를
  프런트엔드로 푸시하며, 프런트엔드는 이를 일관되게 처리합니다.
- **`reqwest`**는 `rustls-tls`를 사용합니다(시스템 OpenSSL 의존성 없음).
- **키**는 오직 localStorage에만 저장됩니다. 실행을 중단하면 프런트엔드가 수신을 멈추고,
  진행 중인 백엔드 HTTP 요청은 백그라운드에서 완료됩니다.

## 로드맵

- 단일 글 모드를 위한 멀티 모델 공동 집필(작성자→편집자 체인 / 비교용 병렬 변형).
- 원탁 토론 모드(같은 질문, 여러 모델, 여러 라운드 + 요약).

## 라이선스

[MIT](./LICENSE)
