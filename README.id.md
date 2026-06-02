<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**Aplikasi desktop alur kerja multi-model yang ringan.**
Rangkai berbagai LLM menjadi sebuah pipeline di mana setiap langkah mengerjakan satu tugas — keluaran satu langkah menjadi masukan langkah berikutnya.

[简体中文](./README.zh.md) · [English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Tiếng Việt](./README.vi.md) · Bahasa Indonesia · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · vanilla TypeScript · tanpa framework frontend

</div>

---

## Apa itu council

`council` memungkinkan Anda merangkai beberapa model menjadi sebuah **pipeline** linear. Setiap langkah memilih
modelnya sendiri (API yang dihosting, atau CLI lokal seperti Claude Code / Codex) dan mengerjakan satu hal — menyusun draf, merevisi,
memeriksa fakta, memoles — lalu meneruskan keluarannya ke hilir. Tersedia juga mode **artikel-tunggal** sekali jalan
(GEO) untuk menghasilkan artikel jadi + posting media sosial dalam satu langkah, dengan opsi
pembuatan gambar inline.

Semuanya berjalan secara lokal sebagai aplikasi desktop native. **Kunci API hanya tersimpan di
localStorage browser Anda** — dan tidak pernah dikirim ke mana pun selain endpoint penyedia yang Anda konfigurasikan.

## Fitur

- **Pipeline teks** — beberapa langkah, masing-masing dengan model dan instruksinya sendiri. Rujuk keluaran
  dari hulu dengan placeholder: `{{input}}` (masukan awal), `{{prev}}` (langkah sebelumnya), `{{1}}` `{{2}}` … (langkah ke-N).
- **Pasar model** — preset untuk DeepSeek, OpenAI, Gemini, Qwen, Kimi, GLM, xAI Grok, Mistral,
  Volcengine Doubao, Ollama, MiniMax. Endpoint `/chat/completions` apa pun yang kompatibel dengan OpenAI bisa dipakai dengan
  menambahkan penyedia.
- **Worker CLI lokal** — jalankan agen lokal (Claude Code, Codex, Gemini CLI, Grok CLI) sebagai langkah
  pipeline lewat `cli_run` generik (program + args + prompt).
- **Pustaka skill** — prompt `SKILL.md` yang dapat dipakai ulang di `~/.council/skills`, bisa dilampirkan per langkah.
  Impor dari berkas/folder lokal, atau sinkronkan dengan repo git (unduh / unggah).
- **Mode artikel-tunggal (GEO)** — generator mandiri: judul/topik, opsi rute/tempat,
  10 gaya penulisan, slider panjang, beri bahan mentah atau URL rujukan, opsi gambar
  inline. Menghasilkan artikel yang dapat disunting + posting media sosial singkat; salin atau ekspor ke Markdown.
- **Pembuatan gambar** — teks-ke-gambar lewat endpoint bergaya OpenAI-images (mis. Volcengine Seedream),
  atau SVG lewat worker CLI lokal.
- **Pembuatan video** — teks-ke-video asinkron (Volcengine Ark / Seedance), ditampilkan di kartu hasil.
- **Workflow bernama** — simpan / muat / hapus seluruh pipeline sebagai berkas.

## Menjalankannya

Persyaratan: [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/) (stable), dan
[prasyarat Tauri 2](https://tauri.app/start/prerequisites/) untuk OS Anda.

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## Penggunaan

1. Buka **厂商 / 命令 / Key** (Providers / Commands / Keys) di bilah atas dan tempel kunci API Anda.
   Penyedia DeepSeek sudah disiapkan — cukup tambahkan kuncinya. Untuk layanan lain yang kompatibel dengan OpenAI,
   klik untuk menambahkan penyedia dan atur Endpoint-nya hingga termasuk `/chat/completions`.
2. Di panel kiri, bangun pipeline: setiap langkah memilih sebuah model (atau CLI lokal) dan sebuah instruksi.
3. Gunakan placeholder dalam instruksi untuk merujuk keluaran dari hulu:
   - `{{input}}` — masukan awal di bagian atas
   - `{{prev}}` — keluaran langkah sebelumnya
   - `{{1}}` `{{2}}` … — keluaran langkah ke-N
4. Klik **▶ 运行 (Run)**. Langkah-langkah dieksekusi dari atas ke bawah dan dialirkan ke panel hasil di sebelah kanan.
5. Beralih ke **单篇 (Single-article)** di bilah atas untuk generator GEO sekali jalan.

## Arsitektur

Backend Rust (`src-tauri/src/lib.rs`) mengekspos sejumlah perintah Tauri; frontend vanilla-TS
mengatur pipeline dan mengalirkan setiap langkah.

| Command | Tujuan |
| --- | --- |
| `chat_stream` | `/chat/completions` yang kompatibel dengan OpenAI (SSE), mengalirkan delta lewat Tauri Channel |
| `cli_run` | menjalankan worker CLI lokal (program + args tetap + prompt sebagai argv terakhir) |
| `fetch_url` | mengambil halaman web dan mengekstrak teks yang mudah dibaca (untuk pengumpanan URL-rujukan) |
| `image_generate` | teks-ke-gambar (bergaya OpenAI-images, mengembalikan URL gambar) |
| `video_generate` | API tugas teks-ke-video asinkron (kirim + polling), mengembalikan URL video |
| `*_workflow` / `*_skill` | simpan / muat / daftar / hapus workflow dan skill; unduh / unggah skill via git |

- **Streaming**: baik worker HTTP maupun CLI mendorong teks inkremental ke frontend lewat Tauri
  `Channel<StreamEvent>`; frontend menanganinya secara seragam.
- **`reqwest`** memakai `rustls-tls` (tanpa ketergantungan OpenSSL sistem).
- **Kunci** hanya disimpan di localStorage. Menghentikan sebuah run membuat frontend berhenti mendengarkan; permintaan
  HTTP backend yang sedang berjalan akan tuntas di latar belakang.

## Roadmap

- Penulisan bersama multi-model untuk mode artikel-tunggal (rantai penulis→editor / varian paralel untuk dibandingkan).
- Mode diskusi meja bundar (pertanyaan yang sama, beberapa model, beberapa putaran + ringkasan).

## Lisensi

[MIT](./LICENSE)
