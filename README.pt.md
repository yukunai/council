<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**Um aplicativo de desktop leve para fluxos de trabalho multimodelo.**
Encadeie diferentes LLMs em um pipeline onde cada etapa faz uma única tarefa — a saída de uma etapa alimenta a próxima.

[简体中文](./README.zh.md) · [English](./README.md) · [Español](./README.es.md) · Português · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Tiếng Việt](./README.vi.md) · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · vanilla TypeScript · sem framework de frontend

</div>

---

## O que é

O `council` permite conectar vários modelos em um **pipeline** linear. Cada etapa escolhe seu próprio
modelo (uma API hospedada ou um CLI local como Claude Code / Codex) e faz uma única coisa — rascunhar, revisar,
checar fatos, refinar — repassando sua saída adiante. Há também um modo **artigo único** de passe único
(GEO) para gerar um artigo finalizado + post para redes sociais em uma única passagem, com geração
de imagens em linha opcional.

Tudo roda localmente como um aplicativo de desktop nativo. **As chaves de API ficam apenas no
localStorage do seu navegador** — elas nunca são enviadas para lugar algum, exceto o endpoint do provedor que você configurar.

## Recursos

- **Pipeline de texto** — múltiplas etapas, cada uma com seu próprio modelo e instrução. Referencie a saída
  anterior com marcadores: `{{input}}` (entrada inicial), `{{prev}}` (etapa anterior), `{{1}}` `{{2}}` … (etapa N).
- **Mercado de modelos** — predefinições para DeepSeek, OpenAI, Gemini, Qwen, Kimi, GLM, xAI Grok, Mistral,
  Volcengine Doubao, Ollama, MiniMax. Qualquer endpoint `/chat/completions` compatível com OpenAI funciona
  ao adicionar um provedor.
- **Workers de CLI local** — opere agentes locais (Claude Code, Codex, Gemini CLI, Grok CLI) como etapas do
  pipeline por meio de um `cli_run` genérico (programa + argumentos + prompt).
- **Biblioteca de skills** — prompts `SKILL.md` reutilizáveis em `~/.council/skills`, anexáveis por etapa.
  Importe de arquivos/pastas locais ou sincronize com um repositório git (download / upload).
- **Modo artigo único (GEO)** — um gerador autônomo: título/tópico, rota/locais opcionais,
  10 estilos de escrita, controle deslizante de tamanho, alimente-o com material bruto ou uma URL de referência, imagens
  em linha opcionais. Produz um artigo editável + um post curto para redes sociais; copie ou exporte para Markdown.
- **Geração de imagens** — texto para imagem via endpoints no estilo OpenAI-images (ex.: Volcengine Seedream),
  ou SVG por meio de um worker de CLI local.
- **Geração de vídeo** — texto para vídeo assíncrono (Volcengine Ark / Seedance), renderizado no cartão de resultado.
- **Fluxos de trabalho nomeados** — salve / carregue / exclua pipelines inteiros como arquivos.

## Como executar

Requisitos: [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/) (estável) e os
[pré-requisitos do Tauri 2](https://tauri.app/start/prerequisites/) para o seu sistema operacional.

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## Uso

1. Abra **厂商 / 命令 / Key** (Provedores / Comandos / Chaves) na barra superior e cole sua chave de API.
   Um provedor DeepSeek já vem configurado — basta adicionar a chave. Para qualquer outro serviço compatível com OpenAI,
   clique para adicionar um provedor e defina seu Endpoint até e incluindo `/chat/completions`.
2. No painel esquerdo, monte o pipeline: cada etapa escolhe um modelo (ou um CLI local) e uma instrução.
3. Use marcadores nas instruções para referenciar a saída anterior:
   - `{{input}}` — a entrada inicial no topo
   - `{{prev}}` — a saída da etapa anterior
   - `{{1}}` `{{2}}` … — a saída da etapa N
4. Clique em **▶ 运行 (Executar)**. As etapas são executadas de cima para baixo e fluem para o painel de resultados à direita.
5. Alterne para **单篇 (Artigo único)** na barra superior para o gerador GEO de passe único.

## Arquitetura

O backend em Rust (`src-tauri/src/lib.rs`) expõe um punhado de comandos do Tauri; o frontend em
vanilla-TS orquestra o pipeline e transmite cada etapa.

| Command | Propósito |
| --- | --- |
| `chat_stream` | `/chat/completions` compatível com OpenAI (SSE), transmite deltas por um Channel do Tauri |
| `cli_run` | executa um worker de CLI local (programa + argumentos fixos + prompt como argv final) |
| `fetch_url` | busca uma página web e extrai o texto legível (para alimentação por URL de referência) |
| `image_generate` | texto para imagem (estilo OpenAI-images, retorna uma URL de imagem) |
| `video_generate` | API de tarefa assíncrona de texto para vídeo (enviar + consultar), retorna uma URL de vídeo |
| `*_workflow` / `*_skill` | salvar / carregar / listar / excluir fluxos de trabalho e skills; download / upload de skills via git |

- **Streaming**: tanto os workers HTTP quanto os de CLI enviam texto incremental ao frontend por um
  `Channel<StreamEvent>` do Tauri; o frontend os trata de forma uniforme.
- **`reqwest`** usa `rustls-tls` (sem dependência do OpenSSL do sistema).
- **Chaves** são armazenadas apenas no localStorage. Parar uma execução faz o frontend deixar de escutar; uma
  requisição HTTP de backend em andamento é concluída em segundo plano.

## Roadmap

- Coautoria multimodelo para o modo artigo único (cadeia escritor→editor / variantes paralelas para comparar).
- Modo de discussão em mesa-redonda (mesma pergunta, múltiplos modelos, múltiplas rodadas + resumo).

## Licença

[MIT](./LICENSE)
