<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**Una aplicación de escritorio ligera para flujos de trabajo multimodelo.**
Encadena distintos LLM en una canalización donde cada paso hace una sola tarea: la salida de un paso alimenta al siguiente.

[简体中文](./README.zh.md) · [English](./README.md) · Español · [Português](./README.pt.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Tiếng Việt](./README.vi.md) · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · TypeScript puro · sin framework de frontend

</div>

---

## Qué es

`council` te permite conectar varios modelos en una **canalización** lineal. Cada paso elige su propio
modelo (una API alojada, o una CLI local como Claude Code / Codex) y hace una sola cosa: redactar, revisar,
verificar datos, pulir, pasando su salida al siguiente paso. También hay un modo **artículo único** de
una sola pasada (GEO) para generar un artículo terminado + una publicación social en una única ejecución, con
generación de imágenes en línea opcional.

Todo se ejecuta localmente como una aplicación de escritorio nativa. **Las claves de API viven únicamente en el
localStorage de tu navegador**: nunca se envían a ningún sitio salvo al endpoint del proveedor que configures.

## Funcionalidades

- **Canalización de texto** — varios pasos, cada uno con su propio modelo e instrucción. Referencia la salida
  anterior con marcadores de posición: `{{input}}` (entrada inicial), `{{prev}}` (paso anterior), `{{1}}` `{{2}}` … (paso N).
- **Mercado de modelos** — preajustes para DeepSeek, OpenAI, Gemini, Qwen, Kimi, GLM, xAI Grok, Mistral,
  Volcengine Doubao, Ollama, MiniMax. Cualquier endpoint `/chat/completions` compatible con OpenAI funciona
  añadiendo un proveedor.
- **Trabajadores CLI locales** — controla agentes locales (Claude Code, Codex, Gemini CLI, Grok CLI) como pasos
  de la canalización mediante un `cli_run` genérico (programa + argumentos + prompt).
- **Biblioteca de skills** — prompts `SKILL.md` reutilizables en `~/.council/skills`, adjuntables por paso.
  Importa desde archivos/carpetas locales, o sincroniza con un repositorio git (descarga / subida).
- **Modo artículo único (GEO)** — un generador independiente: título/tema, ruta/lugares opcionales,
  10 estilos de escritura, control deslizante de longitud, aliméntalo con material en bruto o una URL de
  referencia, imágenes en línea opcionales. Produce un artículo editable + una publicación social breve;
  copia o exporta a Markdown.
- **Generación de imágenes** — texto a imagen mediante endpoints estilo OpenAI-images (p. ej. Volcengine Seedream),
  o SVG mediante un trabajador CLI local.
- **Generación de vídeo** — texto a vídeo asíncrono (Volcengine Ark / Seedance), renderizado en la tarjeta de resultado.
- **Flujos de trabajo con nombre** — guarda / carga / elimina canalizaciones completas como archivos.

## Cómo ejecutarlo

Requisitos: [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/) (estable), y los
[prerequisitos de Tauri 2](https://tauri.app/start/prerequisites/) para tu sistema operativo.

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## Uso

1. Abre **Proveedores / Comandos / Claves** en la barra superior y pega tu clave de API.
   Hay un proveedor DeepSeek precargado: solo añade la clave. Para cualquier otro servicio compatible con
   OpenAI, haz clic para añadir un proveedor y configura su Endpoint hasta incluir `/chat/completions`.
2. En el panel izquierdo, construye la canalización: cada paso elige un modelo (o una CLI local) y una instrucción.
3. Usa marcadores de posición en las instrucciones para referenciar la salida anterior:
   - `{{input}}` — la entrada inicial de arriba
   - `{{prev}}` — la salida del paso anterior
   - `{{1}}` `{{2}}` … — la salida del paso N
4. Haz clic en **▶ Ejecutar**. Los pasos se ejecutan de arriba abajo y fluyen en streaming al panel de resultados de la derecha.
5. Cambia a **Artículo único** en la barra superior para el generador GEO de una sola pasada.

## Arquitectura

El backend en Rust (`src-tauri/src/lib.rs`) expone un puñado de comandos de Tauri; el frontend en
TypeScript puro orquesta la canalización y transmite cada paso en streaming.

| Command | Propósito |
| --- | --- |
| `chat_stream` | `/chat/completions` compatible con OpenAI (SSE), transmite deltas en streaming a través de un Channel de Tauri |
| `cli_run` | ejecuta un trabajador CLI local (programa + argumentos fijos + prompt como argv final) |
| `fetch_url` | obtiene una página web y extrae el texto legible (para alimentar la URL de referencia) |
| `image_generate` | texto a imagen (estilo OpenAI-images, devuelve una URL de imagen) |
| `video_generate` | API de tarea asíncrona de texto a vídeo (enviar + sondear), devuelve una URL de vídeo |
| `*_workflow` / `*_skill` | guardar / cargar / listar / eliminar flujos de trabajo y skills; descarga / subida de skills por git |

- **Streaming**: tanto los trabajadores HTTP como los CLI envían texto incremental al frontend a través de un
  `Channel<StreamEvent>` de Tauri; el frontend los gestiona de forma uniforme.
- **`reqwest`** usa `rustls-tls` (sin dependencia del OpenSSL del sistema).
- **Las claves** se almacenan únicamente en localStorage. Detener una ejecución hace que el frontend deje de
  escuchar; una solicitud HTTP del backend en curso termina en segundo plano.

## Hoja de ruta

- Coescritura multimodelo para el modo de artículo único (cadena escritor→editor / variantes paralelas para comparar).
- Modo de mesa redonda (misma pregunta, varios modelos, varias rondas + resumen).

## Licencia

[MIT](./LICENSE)
