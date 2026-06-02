<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**Hafif, çok modelli bir iş akışı masaüstü uygulaması.**
Farklı LLM'leri, her adımın tek bir işi yaptığı bir hat (pipeline) içinde zincirleyin — bir adımın çıktısı bir sonrakini besler.

[简体中文](./README.zh.md) · [English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Tiếng Việt](./README.vi.md) · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · Türkçe · [العربية](./README.ar.md)

Tauri 2 · vanilla TypeScript · ön yüz çerçevesi yok

</div>

---

## Nedir

`council`, birden çok modeli doğrusal bir **hat** (pipeline) içinde birbirine bağlamanıza olanak tanır. Her adım kendi modelini seçer (barındırılan bir API ya da Claude Code / Codex gibi yerel bir CLI) ve tek bir iş yapar — taslak hazırlama, gözden geçirme, doğrulama, cilalama — ardından çıktısını sonraki adıma aktarır. Ayrıca, isteğe bağlı satır içi görsel üretimiyle birlikte tek geçişte bitmiş bir makale + sosyal medya gönderisi üreten tek seferlik bir **tek makale** modu (GEO) da vardır.

Her şey yerel olarak, yerel bir masaüstü uygulaması olarak çalışır. **API anahtarları yalnızca tarayıcınızın localStorage'ında bulunur** — yapılandırdığınız sağlayıcı uç noktası dışında hiçbir yere gönderilmezler.

## Özellikler

- **Metin hattı** — her biri kendi modeli ve yönergesi olan birden çok adım. Yukarı akış çıktısına yer tutucularla başvurun: `{{input}}` (ilk girdi), `{{prev}}` (önceki adım), `{{1}}` `{{2}}` … (N. adım).
- **Model pazarı** — DeepSeek, OpenAI, Gemini, Qwen, Kimi, GLM, xAI Grok, Mistral, Volcengine Doubao, Ollama, MiniMax için hazır ayarlar. OpenAI uyumlu herhangi bir `/chat/completions` uç noktası, bir sağlayıcı eklenerek çalışır.
- **Yerel CLI işçileri** — yerel ajanları (Claude Code, Codex, Gemini CLI, Grok CLI) genel bir `cli_run` (program + argümanlar + istem) aracılığıyla hat adımları olarak çalıştırın.
- **Beceri kütüphanesi** — `~/.council/skills` içinde, adım bazında eklenebilen yeniden kullanılabilir `SKILL.md` istemleri. Yerel dosyalardan/klasörlerden içe aktarın ya da bir git deposuyla eşitleyin (indir / yükle).
- **Tek makale (GEO) modu** — bağımsız bir üretici: başlık/konu, isteğe bağlı rota/yerler, 10 yazı stili, uzunluk kaydırıcısı, ona ham malzeme ya da bir referans URL'si verin, isteğe bağlı satır içi görseller. Düzenlenebilir bir makale + kısa bir sosyal medya gönderisi üretir; kopyalayın ya da Markdown'a dışa aktarın.
- **Görsel üretimi** — OpenAI görsel tarzı uç noktalar (ör. Volcengine Seedream) aracılığıyla metinden görsele ya da yerel bir CLI işçisi aracılığıyla SVG.
- **Video üretimi** — eşzamansız metinden videoya (Volcengine Ark / Seedance), sonuç kartında işlenir.
- **Adlandırılmış iş akışları** — hat'ların tamamını dosya olarak kaydedin / yükleyin / silin.

## Çalıştırma

Gereksinimler: [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/) (kararlı) ve işletim sisteminiz için [Tauri 2 ön gereksinimleri](https://tauri.app/start/prerequisites/).

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## Kullanım

1. Üst çubukta **厂商 / 命令 / Key** (Sağlayıcılar / Komutlar / Anahtarlar) bölümünü açın ve API anahtarınızı yapıştırın. Bir DeepSeek sağlayıcısı önceden tanımlıdır — yalnızca anahtarı ekleyin. OpenAI uyumlu başka herhangi bir hizmet için, bir sağlayıcı eklemek üzere tıklayın ve uç noktasını `/chat/completions` dahil olacak şekilde ayarlayın.
2. Sol panelde hattı oluşturun: her adım bir model (ya da yerel bir CLI) ve bir yönerge seçer.
3. Yukarı akış çıktısına başvurmak için yönergelerde yer tutucuları kullanın:
   - `{{input}}` — en üstteki ilk girdi
   - `{{prev}}` — önceki adımın çıktısı
   - `{{1}}` `{{2}}` … — N. adımın çıktısı
4. **▶ 运行 (Çalıştır)** düğmesine tıklayın. Adımlar yukarıdan aşağıya yürütülür ve sağdaki sonuçlar paneline akış halinde gelir.
5. Tek seferlik GEO üreticisi için üst çubukta **单篇 (Tek makale)** moduna geçin.

## Mimari

Rust arka ucu (`src-tauri/src/lib.rs`) bir avuç Tauri komutu sunar; vanilla-TS ön yüzü hattı düzenler ve her adımı akış halinde aktarır.

| Command | Amaç |
| --- | --- |
| `chat_stream` | OpenAI uyumlu `/chat/completions` (SSE); deltaları bir Tauri Channel üzerinden akıtır |
| `cli_run` | yerel bir CLI işçisini çalıştırır (program + sabit argümanlar + son argv olarak istem) |
| `fetch_url` | bir web sayfasını getirir ve okunabilir metni çıkarır (referans URL beslemesi için) |
| `image_generate` | metinden görsele (OpenAI görsel tarzı, bir görsel URL'si döndürür) |
| `video_generate` | eşzamansız metinden videoya görev API'si (gönder + yokla), bir video URL'si döndürür |
| `*_workflow` / `*_skill` | iş akışlarını ve becerileri kaydet / yükle / listele / sil; becerilerin git ile indirilmesi / yüklenmesi |

- **Akış**: hem HTTP hem de CLI işçileri, artımlı metni bir Tauri `Channel<StreamEvent>` üzerinden ön yüze iter; ön yüz bunları tek tip biçimde işler.
- **`reqwest`**, `rustls-tls` kullanır (sistem OpenSSL bağımlılığı yoktur).
- **Anahtarlar** yalnızca localStorage'da saklanır. Bir çalıştırmayı durdurmak, ön yüzün dinlemesini durdurur; devam etmekte olan bir arka uç HTTP isteği arka planda tamamlanır.

## Yol haritası

- Tek makale modu için çok modelli ortak yazım (yazar→editör zinciri / karşılaştırmak için paralel varyantlar).
- Yuvarlak masa tartışma modu (aynı soru, birden çok model, birden çok tur + özet).

## Lisans

[MIT](./LICENSE)
