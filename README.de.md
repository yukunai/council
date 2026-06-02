<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**Eine schlanke Multi-Modell-Workflow-Desktop-App.**
Verkette verschiedene LLMs zu einer Pipeline, in der jeder Schritt eine Aufgabe erledigt — die Ausgabe eines Schritts dient als Eingabe des nächsten.

[简体中文](./README.zh.md) · [English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · Deutsch · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Tiếng Việt](./README.vi.md) · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · vanilla TypeScript · kein Frontend-Framework

</div>

---

## Was es ist

Mit `council` verdrahtest du mehrere Modelle zu einer linearen **Pipeline**. Jeder Schritt wählt sein eigenes
Modell (eine gehostete API oder ein lokales CLI wie Claude Code / Codex) und erledigt eine Sache — entwerfen, überarbeiten,
Fakten prüfen, polieren — und reicht seine Ausgabe nach unten weiter. Es gibt außerdem einen einmaligen **Single-Article**-
Modus (GEO), um in einem einzigen Durchlauf einen fertigen Artikel + Social-Post zu generieren, mit optionaler
inline eingebetteter Bildgenerierung.

Alles läuft lokal als native Desktop-App. **API-Schlüssel leben ausschließlich im localStorage
deines Browsers** — sie werden nirgendwohin gesendet außer an den von dir konfigurierten Anbieter-Endpunkt.

## Funktionen

- **Text-Pipeline** — mehrere Schritte, jeder mit eigenem Modell und eigener Anweisung. Verweise auf vorgelagerte
  Ausgaben mit Platzhaltern: `{{input}}` (anfängliche Eingabe), `{{prev}}` (vorheriger Schritt), `{{1}}` `{{2}}` … (Schritt N).
- **Modell-Markt** — Voreinstellungen für DeepSeek, OpenAI, Gemini, Qwen, Kimi, GLM, xAI Grok, Mistral,
  Volcengine Doubao, Ollama, MiniMax. Jeder OpenAI-kompatible `/chat/completions`-Endpunkt funktioniert, indem du
  einen Anbieter hinzufügst.
- **Lokale CLI-Worker** — steuere lokale Agenten (Claude Code, Codex, Gemini CLI, Grok CLI) als Pipeline-
  Schritte über ein generisches `cli_run` (Programm + Argumente + Prompt).
- **Skills-Bibliothek** — wiederverwendbare `SKILL.md`-Prompts in `~/.council/skills`, pro Schritt anhängbar.
  Importiere aus lokalen Dateien/Ordnern oder synchronisiere mit einem git-Repo (Download / Upload).
- **Single-Article-Modus (GEO)** — ein eigenständiger Generator: Titel/Thema, optional Route/Orte,
  10 Schreibstile, Längen-Schieberegler, füttere ihn mit Rohmaterial oder einer Referenz-URL, optional inline
  eingebettete Bilder. Liefert einen bearbeitbaren Artikel + einen kurzen Social-Post; kopieren oder als Markdown exportieren.
- **Bildgenerierung** — Text-zu-Bild über Endpunkte im OpenAI-Images-Stil (z. B. Volcengine Seedream)
  oder SVG über einen lokalen CLI-Worker.
- **Videogenerierung** — asynchrones Text-zu-Video (Volcengine Ark / Seedance), gerendert in der Ergebniskarte.
- **Benannte Workflows** — speichere / lade / lösche ganze Pipelines als Dateien.

## Ausführen

Voraussetzungen: [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/) (stable) und die
[Tauri-2-Voraussetzungen](https://tauri.app/start/prerequisites/) für dein Betriebssystem.

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## Verwendung

1. Öffne **厂商 / 命令 / Key** (Providers / Commands / Keys) in der oberen Leiste und füge deinen API-Schlüssel ein.
   Ein DeepSeek-Anbieter ist vorbelegt — füge einfach den Schlüssel hinzu. Für jeden anderen OpenAI-kompatiblen Dienst
   klicke, um einen Anbieter hinzuzufügen, und setze seinen Endpunkt bis einschließlich `/chat/completions`.
2. Baue im linken Bereich die Pipeline: Jeder Schritt wählt ein Modell (oder ein lokales CLI) und eine Anweisung.
3. Verwende Platzhalter in Anweisungen, um auf vorgelagerte Ausgaben zu verweisen:
   - `{{input}}` — die anfängliche Eingabe ganz oben
   - `{{prev}}` — die Ausgabe des vorherigen Schritts
   - `{{1}}` `{{2}}` … — die Ausgabe von Schritt N
4. Klicke auf **▶ 运行 (Run)**. Schritte werden von oben nach unten ausgeführt und streamen in den rechten Ergebnisbereich.
5. Wechsle in der oberen Leiste zu **单篇 (Single-article)** für den einmaligen GEO-Generator.

## Architektur

Das Rust-Backend (`src-tauri/src/lib.rs`) stellt eine Handvoll Tauri-Befehle bereit; das vanilla-TS-
Frontend orchestriert die Pipeline und streamt jeden Schritt.

| Command | Zweck |
| --- | --- |
| `chat_stream` | OpenAI-kompatibles `/chat/completions` (SSE), streamt Deltas über einen Tauri-Channel |
| `cli_run` | führt einen lokalen CLI-Worker aus (Programm + feste Argumente + Prompt als letztes argv) |
| `fetch_url` | ruft eine Webseite ab und extrahiert lesbaren Text (für die Referenz-URL-Fütterung) |
| `image_generate` | Text-zu-Bild (OpenAI-Images-Stil, gibt eine Bild-URL zurück) |
| `video_generate` | asynchrone Text-zu-Video-Task-API (Absenden + Abfragen), gibt eine Video-URL zurück |
| `*_workflow` / `*_skill` | Workflows und Skills speichern / laden / auflisten / löschen; git-Download / -Upload von Skills |

- **Streaming**: Sowohl HTTP- als auch CLI-Worker schieben inkrementellen Text an das Frontend über einen Tauri-
  `Channel<StreamEvent>`; das Frontend verarbeitet sie einheitlich.
- **`reqwest`** verwendet `rustls-tls` (keine Abhängigkeit vom System-OpenSSL).
- **Schlüssel** werden nur im localStorage gespeichert. Das Stoppen eines Laufs beendet das Lauschen des Frontends; eine
  laufende Backend-HTTP-Anfrage wird im Hintergrund zu Ende geführt.

## Roadmap

- Multi-Modell-Co-Writing für den Single-Article-Modus (Autor→Lektor-Kette / parallele Varianten zum Vergleich).
- Diskussionsmodus am runden Tisch (gleiche Frage, mehrere Modelle, mehrere Runden + Zusammenfassung).

## Lizenz

[MIT](./LICENSE)
