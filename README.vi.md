<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**Ứng dụng desktop quy trình đa mô hình nhẹ nhàng.**
Kết nối nhiều LLM khác nhau thành một pipeline, trong đó mỗi bước làm một việc — đầu ra của bước này là đầu vào của bước kế tiếp.

[简体中文](./README.zh.md) · [English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · Tiếng Việt · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · vanilla TypeScript · không dùng framework frontend

</div>

---

## Là gì

`council` cho phép bạn nối nhiều mô hình thành một **pipeline** tuyến tính. Mỗi bước tự chọn mô hình
riêng của mình (một API được host, hoặc một CLI cục bộ như Claude Code / Codex) và làm một việc — soạn thảo, chỉnh sửa,
kiểm chứng, trau chuốt — rồi chuyển đầu ra của mình xuống bước sau. Ngoài ra còn có chế độ **một bài viết** chạy một lần
(GEO) để tạo một bài viết hoàn chỉnh + bài đăng mạng xã hội chỉ trong một lượt, kèm tùy chọn
tạo ảnh nội dòng.

Mọi thứ chạy cục bộ dưới dạng một ứng dụng desktop gốc. **Các API key chỉ nằm trong
localStorage của trình duyệt** — chúng không bao giờ được gửi đi đâu khác ngoài endpoint nhà cung cấp mà bạn cấu hình.

## Tính năng

- **Pipeline văn bản** — nhiều bước, mỗi bước có mô hình và chỉ dẫn riêng. Tham chiếu đầu ra
  của các bước trước bằng placeholder: `{{input}}` (đầu vào ban đầu), `{{prev}}` (bước trước), `{{1}}` `{{2}}` … (bước N).
- **Chợ mô hình** — preset có sẵn cho DeepSeek, OpenAI, Gemini, Qwen, Kimi, GLM, xAI Grok, Mistral,
  Volcengine Doubao, Ollama, MiniMax. Bất kỳ endpoint `/chat/completions` tương thích OpenAI nào cũng dùng được bằng cách
  thêm một nhà cung cấp.
- **Worker CLI cục bộ** — điều khiển các agent cục bộ (Claude Code, Codex, Gemini CLI, Grok CLI) như những
  bước trong pipeline thông qua một `cli_run` tổng quát (chương trình + tham số + prompt).
- **Thư viện kỹ năng** — các prompt `SKILL.md` tái sử dụng trong `~/.council/skills`, có thể gắn vào từng bước.
  Nhập từ tệp/thư mục cục bộ, hoặc đồng bộ với một kho git (tải xuống / tải lên).
- **Chế độ một bài viết (GEO)** — một bộ tạo độc lập: tiêu đề/chủ đề, tùy chọn lộ trình/địa điểm,
  10 phong cách viết, thanh trượt độ dài, cấp cho nó tư liệu thô hoặc một URL tham khảo, tùy chọn ảnh
  nội dòng. Xuất ra một bài viết có thể chỉnh sửa + một bài đăng mạng xã hội ngắn; sao chép hoặc xuất sang Markdown.
- **Tạo ảnh** — text-to-image qua các endpoint kiểu OpenAI-images (ví dụ Volcengine Seedream),
  hoặc SVG qua một worker CLI cục bộ.
- **Tạo video** — text-to-video bất đồng bộ (Volcengine Ark / Seedance), hiển thị trong thẻ kết quả.
- **Quy trình có tên** — lưu / tải / xóa toàn bộ pipeline dưới dạng tệp.

## Chạy thử

Yêu cầu: [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/) (bản ổn định), và
[các điều kiện tiên quyết của Tauri 2](https://tauri.app/start/prerequisites/) cho hệ điều hành của bạn.

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## Cách dùng

1. Mở **厂商 / 命令 / Key** (Nhà cung cấp / Lệnh / Khóa) trên thanh trên cùng và dán API key của bạn.
   Một nhà cung cấp DeepSeek đã được tạo sẵn — chỉ cần thêm khóa. Với bất kỳ dịch vụ tương thích OpenAI nào khác,
   bấm để thêm một nhà cung cấp và đặt Endpoint của nó cho đến và bao gồm cả `/chat/completions`.
2. Trong bảng bên trái, dựng pipeline: mỗi bước chọn một mô hình (hoặc một CLI cục bộ) và một chỉ dẫn.
3. Dùng placeholder trong chỉ dẫn để tham chiếu đầu ra của các bước trước:
   - `{{input}}` — đầu vào ban đầu ở trên cùng
   - `{{prev}}` — đầu ra của bước trước
   - `{{1}}` `{{2}}` … — đầu ra của bước N
4. Bấm **▶ 运行 (Chạy)**. Các bước thực thi từ trên xuống dưới và stream vào bảng kết quả bên phải.
5. Chuyển sang **单篇 (Một bài viết)** trên thanh trên cùng để dùng bộ tạo GEO chạy một lần.

## Kiến trúc

Backend Rust (`src-tauri/src/lib.rs`) phơi bày một số ít lệnh Tauri; frontend vanilla-TS
điều phối pipeline và stream từng bước.

| Command | Mục đích |
| --- | --- |
| `chat_stream` | `/chat/completions` tương thích OpenAI (SSE), stream các delta qua một Tauri Channel |
| `cli_run` | chạy một worker CLI cục bộ (chương trình + tham số cố định + prompt làm argv cuối cùng) |
| `fetch_url` | tải một trang web và trích xuất văn bản dễ đọc (để cấp URL tham khảo) |
| `image_generate` | text-to-image (kiểu OpenAI-images, trả về một URL ảnh) |
| `video_generate` | API tác vụ text-to-video bất đồng bộ (gửi + poll), trả về một URL video |
| `*_workflow` / `*_skill` | lưu / tải / liệt kê / xóa quy trình và kỹ năng; tải xuống / tải lên kỹ năng qua git |

- **Streaming**: cả worker HTTP lẫn CLI đều đẩy văn bản tăng dần lên frontend qua một Tauri
  `Channel<StreamEvent>`; frontend xử lý chúng một cách đồng nhất.
- **`reqwest`** dùng `rustls-tls` (không phụ thuộc OpenSSL của hệ thống).
- **Khóa** chỉ được lưu trong localStorage. Dừng một lượt chạy sẽ khiến frontend ngừng lắng nghe; một
  yêu cầu HTTP đang chạy ở backend sẽ hoàn tất trong nền.

## Lộ trình

- Đồng sáng tác đa mô hình cho chế độ một bài viết (chuỗi người viết→biên tập / các biến thể song song để so sánh).
- Chế độ thảo luận bàn tròn (cùng một câu hỏi, nhiều mô hình, nhiều vòng + tóm tắt).

## Giấy phép

[MIT](./LICENSE)
