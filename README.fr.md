<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**Une application de bureau légère pour les workflows multi-modèles.**
Enchaînez différents LLM dans un pipeline où chaque étape accomplit une seule tâche — la sortie d'une étape alimente la suivante.

[简体中文](./README.zh.md) · [English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · Français · [Deutsch](./README.de.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Tiếng Việt](./README.vi.md) · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · TypeScript vanilla · aucun framework frontend

</div>

---

## Présentation

`council` vous permet de relier plusieurs modèles dans un **pipeline** linéaire. Chaque étape choisit son
propre modèle (une API hébergée, ou une CLI locale comme Claude Code / Codex) et accomplit une seule tâche — rédiger, réviser,
vérifier les faits, peaufiner — en transmettant sa sortie en aval. Il existe aussi un mode **article unique** à passe unique
(GEO) pour générer un article finalisé + une publication sociale en une seule passe, avec génération
d'images en ligne optionnelle.

Tout s'exécute localement sous la forme d'une application de bureau native. **Les clés API ne résident que dans le
localStorage de votre navigateur** — elles ne sont jamais envoyées ailleurs qu'au point de terminaison du fournisseur que vous configurez.

## Fonctionnalités

- **Pipeline de texte** — plusieurs étapes, chacune avec son propre modèle et sa propre instruction. Référencez la sortie
  en amont avec des espaces réservés : `{{input}}` (entrée initiale), `{{prev}}` (étape précédente), `{{1}}` `{{2}}` … (étape N).
- **Marché de modèles** — des préréglages pour DeepSeek, OpenAI, Gemini, Qwen, Kimi, GLM, xAI Grok, Mistral,
  Volcengine Doubao, Ollama, MiniMax. Tout point de terminaison `/chat/completions` compatible OpenAI fonctionne en
  ajoutant un fournisseur.
- **Workers CLI locaux** — pilotez des agents locaux (Claude Code, Codex, Gemini CLI, Grok CLI) comme étapes de pipeline
  via un `cli_run` générique (programme + arguments + prompt).
- **Bibliothèque de skills** — des prompts `SKILL.md` réutilisables dans `~/.council/skills`, attachables par étape.
  Importez depuis des fichiers/dossiers locaux, ou synchronisez avec un dépôt git (téléchargement / envoi).
- **Mode article unique (GEO)** — un générateur autonome : titre/sujet, itinéraire/lieux optionnels,
  10 styles d'écriture, curseur de longueur, alimentez-le avec de la matière brute ou une URL de référence, images
  en ligne optionnelles. Produit un article modifiable + une courte publication sociale ; copiez ou exportez en Markdown.
- **Génération d'images** — texte-vers-image via des points de terminaison de style OpenAI-images (par ex. Volcengine Seedream),
  ou SVG via un worker CLI local.
- **Génération de vidéos** — texte-vers-vidéo asynchrone (Volcengine Ark / Seedance), rendu dans la carte de résultat.
- **Workflows nommés** — enregistrez / chargez / supprimez des pipelines entiers sous forme de fichiers.

## Lancement

Prérequis : [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/) (stable), et les
[prérequis Tauri 2](https://tauri.app/start/prerequisites/) pour votre système d'exploitation.

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## Utilisation

1. Ouvrez **厂商 / 命令 / Key** (Fournisseurs / Commandes / Clés) dans la barre supérieure et collez votre clé API.
   Un fournisseur DeepSeek est préconfiguré — il suffit d'ajouter la clé. Pour tout autre service compatible OpenAI,
   cliquez pour ajouter un fournisseur et définissez son point de terminaison jusqu'à et y compris `/chat/completions`.
2. Dans le panneau de gauche, construisez le pipeline : chaque étape choisit un modèle (ou une CLI locale) et une instruction.
3. Utilisez des espaces réservés dans les instructions pour référencer la sortie en amont :
   - `{{input}}` — l'entrée initiale en haut
   - `{{prev}}` — la sortie de l'étape précédente
   - `{{1}}` `{{2}}` … — la sortie de l'étape N
4. Cliquez sur **▶ 运行 (Exécuter)**. Les étapes s'exécutent de haut en bas et sont diffusées dans le panneau de résultats à droite.
5. Basculez sur **单篇 (Article unique)** dans la barre supérieure pour le générateur GEO à passe unique.

## Architecture

Le backend Rust (`src-tauri/src/lib.rs`) expose une poignée de commandes Tauri ; le frontend
en TS vanilla orchestre le pipeline et diffuse chaque étape.

| Command | Objectif |
| --- | --- |
| `chat_stream` | `/chat/completions` compatible OpenAI (SSE), diffuse les deltas via un Channel Tauri |
| `cli_run` | exécute un worker CLI local (programme + arguments fixes + prompt comme argv final) |
| `fetch_url` | récupère une page web et en extrait le texte lisible (pour l'alimentation par URL de référence) |
| `image_generate` | texte-vers-image (style OpenAI-images, renvoie une URL d'image) |
| `video_generate` | API de tâche texte-vers-vidéo asynchrone (soumission + interrogation), renvoie une URL de vidéo |
| `*_workflow` / `*_skill` | enregistre / charge / liste / supprime les workflows et skills ; téléchargement / envoi git des skills |

- **Streaming** : les workers HTTP et CLI envoient tous deux du texte incrémental au frontend via un
  `Channel<StreamEvent>` Tauri ; le frontend les traite de manière uniforme.
- **`reqwest`** utilise `rustls-tls` (aucune dépendance à l'OpenSSL système).
- **Les clés** sont stockées uniquement dans le localStorage. Arrêter une exécution empêche le frontend d'écouter ; une
  requête HTTP backend en cours se termine en arrière-plan.

## Feuille de route

- Co-écriture multi-modèles pour le mode article unique (chaîne rédacteur→éditeur / variantes parallèles à comparer).
- Mode discussion en table ronde (même question, plusieurs modèles, plusieurs tours + synthèse).

## Licence

[MIT](./LICENSE)
