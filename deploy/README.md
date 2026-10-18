# Cài Music Room cho văn phòng (self-host)

Bạn cần một máy luôn bật trong văn phòng: mini PC, Mac mini, Raspberry Pi 5 hoặc laptop, có **Docker** (Docker Desktop hoặc Docker Engine kèm Compose v2). Máy này chỉ chạy server; nó không bắt buộc phải là máy nối loa.

## 1. Cài đặt (khoảng 10 phút)

```bash
mkdir music-room && cd music-room
curl -O https://raw.githubusercontent.com/hungnm-developer/music-room-server/develop/deploy/docker-compose.yml
curl -O https://raw.githubusercontent.com/hungnm-developer/music-room-server/develop/deploy/Caddyfile
curl -o .env https://raw.githubusercontent.com/hungnm-developer/music-room-server/develop/deploy/.env.example
```

Sửa file `.env`:

| Biến | Ghi gì |
|---|---|
| `PUBLIC_URL` | Địa chỉ mọi người sẽ dùng, ví dụ `http://192.168.1.20:8080`. Đây là IP trong mạng LAN của máy chạy Docker. Xem IP bằng `ipconfig getifaddr en0` (macOS) hoặc `hostname -I` (Linux) |
| `YOUTUBE_API_KEY` | Không bắt buộc. Có key thì dùng được **tìm kiếm** và **playlist dự phòng**; không có thì chỉ dán link YouTube |
| `LASTFM_API_KEY` | Không bắt buộc. **Gợi ý tiếp theo** và **Radio tự động** có thêm "bài tương tự" từ Last.fm (miễn phí, tạo ở last.fm/api/account/create) |
| `GEMINI_API_KEY`, `GROQ_API_KEY` | Không bắt buộc. AI miễn phí để tách tên nghệ sĩ / bài từ tiêu đề YouTube (thử Gemini trước, lỗi thì Groq). Chỉ gửi tiêu đề và tên kênh |

```bash
docker compose up -d
docker compose ps        # các service đều "Up", api và db hiện "healthy"
```

Mở `PUBLIC_URL` trên trình duyệt, chọn **Tạo phòng**, nhập tên của bạn, tên phòng và **mã PIN quản trị** (4–8 số). Người tạo phòng là quản trị viên.

Mã PIN dùng khi cần lấy lại quyền quản trị:
- Ở tab **Mọi người**, bấm **Nhận quyền quản trị** rồi nhập PIN.
- Quản trị viên mất phiên (đổi trình duyệt, xoá dữ liệu…) vào lại bằng **đúng tên cũ** và PIN.
- Thành viên thường mất phiên chỉ cần vào lại bằng đúng tên cũ (khi tên đó đang offline). Họ giữ bài và tim, nhưng quyền Điều khiển, DJ, Máy phát phải được quản trị viên cấp lại.
- Nhập sai PIN 5 lần trong 15 phút sẽ bị khoá 15 phút. Quản trị viên đổi PIN trong **Cài đặt phòng**.

## 2. Nối loa

1. Trên máy nối loa Bluetooth, mở `PUBLIC_URL/r/<MÃ PHÒNG>/host`. Không cần mật khẩu hay PIN: ai có mã phòng đều mở được trang máy phát.
2. Nếu trang hiện nút **▶ Bắt đầu phát**, bấm một lần. Trình duyệt bắt buộc phải có một lần bấm thì mới cho tự phát nhạc.
3. Để trang ở chế độ toàn màn hình (F11). Mọi người quét mã QR trên màn hình để vào phòng.

Mẹo:
- Tắt chế độ ngủ của máy nối loa.
- Không thu nhỏ tab đang phát.
- Nếu mở trang máy phát ở một máy khác, máy cũ sẽ tự dừng phát.

## Đăng nhập Google (không bắt buộc)

Khách vẫn vào phòng bằng tên như cũ. Đăng nhập Google cho phép vào lại đúng mình ở mọi thiết bị, giữ bài yêu thích theo tài khoản, và chủ phòng luôn có quyền quản trị (không cần PIN).

1. Vào [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → **Create credentials** → **OAuth client ID** → loại **Web application**. Nếu được hỏi, cấu hình **OAuth consent screen** trước (loại *External*, chỉ cần tên app và email).
2. Ở **Authorized JavaScript origins**, thêm địa chỉ web của bạn, ví dụ `https://musicroom.io.vn` (tên miền riêng, §8.8) hoặc `https://<app>.vercel.app`. Với dev thêm `http://localhost:3000`. Google không chấp nhận địa chỉ IP LAN dạng `http://192.168…`, nên trong LAN chỉ máy chạy dev (qua `localhost`) đăng nhập được.
3. Không cần *Authorized redirect URIs* và không cần client secret.
4. Chép **Client ID** (dạng `….apps.googleusercontent.com`) vào biến `GOOGLE_CLIENT_ID` của server, rồi khởi động lại server. Web tự nhận Client ID qua `/api/health`.

### Nhập từ YouTube (cần đăng nhập Google)

Nút **Nhập từ YouTube** (tab Thêm bài → Của tôi) đọc playlist và video đã thích của chính người dùng, chỉ đọc. Cấu hình một lần trong project chứa OAuth Client ID:

1. **APIs & Services → Library**: bật **YouTube Data API v3** cho project này (quota nhập bài tính vào project này, khoảng 1 đơn vị cho 50 video).
2. **Google Auth Platform → Data access** (hoặc *OAuth consent screen → Scopes*): **Add or remove scopes** → thêm `https://www.googleapis.com/auth/youtube.readonly`.
3. **Audience** (hoặc *Test users*): khi app ở chế độ **Testing**, thêm email của từng người được dùng tính năng này (tối đa 100). Họ sẽ thấy cảnh báo "Google chưa xác minh ứng dụng này" → **Tiếp tục**.
4. Muốn mọi tài khoản dùng được mà không có cảnh báo: chuyển app sang **In production** và gửi Google xét duyệt scope này (thường vài tuần). Google chỉ duyệt khi trang chủ và trang chính sách nằm trên **tên miền riêng đã xác minh** (§8.8); không dùng được `*.vercel.app`. Hồ sơ mẫu: [`docs/google-oauth-verification.md`](../docs/google-oauth-verification.md).

Đăng nhập thường không cần các bước này; quyền YouTube chỉ được hỏi khi bấm "Nhập từ YouTube", và được thu hồi khi đóng hộp nhập.

## 3. Lấy YouTube API key (không bắt buộc)

1. Vào https://console.cloud.google.com, tạo một project mới.
2. Mở **APIs & Services → Library**, bật **YouTube Data API v3**.
3. Mở **Credentials → Create credentials → API key**. Nên giới hạn key chỉ dùng cho *YouTube Data API v3*.
4. Ghi key vào `YOUTUBE_API_KEY` trong `.env`, rồi chạy `docker compose up -d`.

Mỗi key có 10.000 đơn vị mỗi ngày. Một lượt tìm mới tốn khoảng 101 đơn vị, tức khoảng 95 lượt mỗi ngày. Kết quả tìm kiếm được cache 24 giờ, còn dán link chỉ tốn 1 đơn vị.

## 4. HTTPS và tên miền (không bắt buộc)

Nếu muốn truy cập từ ngoài văn phòng, hãy trỏ tên miền về máy chạy Docker. Sau đó thêm vào `.env`:

```
SITE_ADDRESS=music.congty.vn
PUBLIC_URL=https://music.congty.vn
```

Trong `docker-compose.yml`, ở service `caddy`, thay dòng `"${PORT:-8080}:8080"` bằng hai dòng `"80:80"` và `"443:443"` (đã có sẵn ở dạng chú thích), rồi chạy `docker compose up -d`. Caddy sẽ tự lấy chứng chỉ HTTPS (cổng 80/443 phải mở ra internet).

## 5. Vận hành

| Việc | Lệnh |
|---|---|
| Xem log | `docker compose logs -f api` |
| Cập nhật phiên bản | `docker compose pull && docker compose up -d` (migration tự chạy) |
| Sao lưu | `docker compose exec db pg_dump -U musicroom musicroom > backup-$(date +%F).sql` |
| Khôi phục | `cat backup.sql \| docker compose exec -T db psql -U musicroom musicroom` |
| Kiểm tra sức khỏe | `curl $PUBLIC_URL/api/health` (200 = ổn, 503 = database lỗi) |
| Dừng | `docker compose down` (dữ liệu vẫn được giữ trong volume) |

## 6. Tự build image thay vì tải về

Đặt hai repo `music-room-server` và `music-room-client` cạnh nhau, rồi chạy:

```bash
cd music-room-server/deploy
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## 7. Checklist thử tay trước khi phát hành

Các mục này cần thiết bị thật nên không tự động hóa được (ma trận case: TC-126, TC-127, TC-128, PW-03…PW-06).

- [ ] Laptop nối loa Bluetooth: mở trang máy phát, bấm **Bắt đầu phát**, nhạc phát ra loa.
- [ ] Phát liên tục 1 giờ không bị ngắt, kể cả khi màn hình laptop tắt.
- [ ] Gửi lời chúc: loa đọc lời chúc, nhạc nhỏ lại trong lúc đọc rồi to trở lại; điện thoại *không* phát tiếng.
- [ ] Bấm soundboard DJ trên điện thoại: âm thanh chỉ phát ra ở loa.
- [ ] iPhone (Safari) và Android (Chrome): quét QR, thêm bài, thả tim, bỏ phiếu, chat.
- [ ] Tắt Wi-Fi của máy phát 30 giây rồi bật lại: điện thoại hiện banner, sau đó nhạc phát tiếp đúng chỗ.
- [ ] Khởi động lại container `api` trong lúc đang phát: phòng, hàng chờ và chat vẫn còn nguyên.

## 8. Deploy miễn phí: Vercel (web) + Render (API) + Neon (database)

Cả ba nền tảng đều có gói miễn phí không cần thẻ. Neon thay cho Render Postgres vì database miễn phí của Render bị xóa sau 30 ngày, còn Neon thì không.

| Phần | Nền tảng | Giới hạn của gói free (10/2026) |
|---|---|---|
| Web (Next.js) | Vercel | Đủ dùng |
| API (NestJS, WebSocket) | Render | 750 giờ/tháng; **ngủ sau 15 phút** không có request, mất khoảng 1 phút để thức dậy |
| Database (PostgreSQL) | Neon | 0,5 GB, 100 CU-giờ/tháng; tự ngủ sau 5 phút không dùng, lần truy vấn đầu sau khi ngủ chậm vài giây |

Ước tính: một văn phòng nghe khoảng 8 giờ/ngày tốn chừng 45 CU-giờ Neon mỗi tháng, nằm trong hạn mức free. Dung lượng dữ liệu nhỏ, vì chat và nhật ký chỉ giữ 200 dòng mỗi phòng.

### 8.1 Neon: tạo database (5 phút)

1. Đăng ký tại https://neon.com, chọn **Create project**, chọn region **AWS Asia Pacific (Singapore)** để gần Việt Nam.
2. Ở **Connect**, chọn *Branch: main*, *Database: neondb*, rồi copy **2 chuỗi kết nối**:
   - Bật **Connection pooling**: chuỗi có `-pooler` trong tên host. Đây là `DATABASE_URL`.
   - Tắt **Connection pooling**: chuỗi không có `-pooler`. Đây là `DIRECT_URL`, chỉ dùng để chạy migration.
3. Giữ nguyên phần đuôi `?sslmode=require&channel_binding=require` mà Neon thêm sẵn.

Không cần tự tạo bảng: server tự chạy migration mỗi lần khởi động.

### 8.2 Render: chạy API

**Cách A, dùng Blueprint:** chọn *Dashboard → New → Blueprint*, trỏ tới repo `music-room-server`, nhánh `develop`. File [`render.yaml`](../render.yaml) tự cấu hình lệnh build/start, health check, `NODE_VERSION`, `TRUST_PROXY` và tự sinh `JWT_SECRET`. Render sẽ hỏi các biến ở bảng dưới.

**Cách B, service đã tạo tay trên dashboard:** `render.yaml` không được dùng; vào *Environment* và đặt **toàn bộ** biến sau:

| Biến | Giá trị | Bắt buộc |
|---|---|---|
| `DATABASE_URL` | Chuỗi Neon **có** `-pooler` | ✅ |
| `DIRECT_URL` | Chuỗi Neon **không có** `-pooler` | ✅ với Neon |
| `PUBLIC_URL` | Địa chỉ web chính thức: `https://musicroom.io.vn` (tên miền riêng, §8.8), hoặc `https://<app>.vercel.app` nếu chưa có | ✅ |
| `CORS_ORIGINS` | Mọi địa chỉ web được gọi API, ngăn bằng dấu phẩy, ví dụ `https://musicroom.io.vn,https://<app>.vercel.app` | ✅ |
| `JWT_SECRET` | `openssl rand -base64 48` | ✅ (Render free không có ổ đĩa lưu lâu dài) |
| `TRUST_PROXY` | `true` | ✅ |
| `NODE_VERSION` | `22` | ✅ |
| `DATA_DIR` | `/tmp/music-room` | nên đặt |
| `YOUTUBE_API_KEY` | key YouTube Data API | tùy chọn |
| `LASTFM_API_KEY` | key Last.fm | tùy chọn |
| `GEMINI_API_KEY` / `GROQ_API_KEY` | key AI miễn phí (Google AI Studio / Groq) | tùy chọn |
| `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` | bot Slack `/music` (§9) | tùy chọn |

Cài đặt khác:
- *Build:* `npm install --include=dev && npm run build`
- *Start:* `npm run start:prod` (tự chạy migration bằng `DIRECT_URL`)
- *Health Check Path:* `/api/health`
- *Region:* **Singapore**, cùng khu vực với Neon.

Kiểm tra: mở `https://<api>.onrender.com/api/health`, phải thấy `"db":"up"`.

Nếu đang dùng Render Postgres, sau khi Neon chạy ổn bạn có thể xóa database cũ trên Render. Dữ liệu v1 chỉ nằm trong RAM nên không có gì cần chuyển.

### 8.3 Vercel: chạy web

*Project → Settings → Environment Variables*, mục Production:

| Biến | Giá trị |
|---|---|
| `NEXT_PUBLIC_SERVER_URL` | `https://<api>.onrender.com` (không có `/` ở cuối); có tên miền riêng cho API thì dùng tên đó (bản đang chạy: `https://api.musicroom.io.vn`, §8.9) |
| `PUBLIC_APP_URL` | Địa chỉ web chính thức, ví dụ `https://musicroom.io.vn` (hoặc `https://<app>.vercel.app` nếu chưa có tên miền riêng): dùng cho link và mã QR trong ảnh xem trước. Nên đặt, vì nếu thiếu thì app phải đoán domain từ header của request, và ảnh xem trước sẽ không được CDN cache |

Biến này được nhúng vào lúc build, nên phải **Redeploy** sau khi đặt. Ảnh xem trước khi chia sẻ link phòng (tên bài, ảnh bìa, mã QR) cũng lấy dữ liệu qua địa chỉ này.

### 8.4 Lưu ý

- **Deploy API trước, web sau.** Lệch phiên bản thì người dùng thấy banner "Có phiên bản mới. Hãy tải lại trang."
- **Link Preview của Vercel** bị API chặn, trừ khi bạn thêm domain đó vào `CORS_ORIGINS`.
- **Render ngủ sau 15 phút** không có request. Khi có người mở trang, kết nối mất khoảng 1 phút; trong lúc ngủ, server không tự chuyển bài. Bật workflow giữ server thức ở §8.7, hoặc xem các lựa chọn khác ở §8.5.
- **Render và Neon phải cùng ở Singapore.** Nếu một bên ở Mỹ hoặc châu Âu, mỗi truy vấn database tốn thêm vài trăm ms và mọi thao tác đều chậm. Cách chuyển ở §8.6.

### 8.5 Các lựa chọn khác

| Lựa chọn | Ưu điểm | Nhược điểm |
|---|---|---|
| **Self-host trên máy văn phòng** (§1–§6) | Hoàn toàn miễn phí, chạy liên tục, độ trễ thấp trong LAN, dùng luôn Postgres trong Docker | Cần một máy luôn bật. Muốn truy cập từ ngoài văn phòng thì dùng Cloudflare Tunnel (miễn phí) |
| **Northflank** (free sandbox) | 2 service không bao giờ ngủ, chạy được WebSocket | Cần thẻ để xác minh |
| **Koyeb** (free) | 1 web service 512 MB | Chỉ có máy chủ ở Frankfurt/Washington (xa Việt Nam); từ 2/2026 cần thẻ và tạm giữ $29; ngủ sau 1 giờ không dùng |
| **Render Starter** (khoảng $7/tháng) | Không ngủ, giữ nguyên toàn bộ cấu hình §8.2 | Có phí |
| Supabase (database) | Free 500 MB | Project tự tạm dừng sau 1 tuần không hoạt động |

Không dùng Vercel Functions, Netlify hay Cloudflare Workers cho API: server cần giữ kết nối WebSocket và hẹn giờ chạy liên tục.

### 8.6 Chuyển API và database sang Singapore

Render và Neon đều **không đổi được khu vực** của service hoặc database đã tạo, nên phải tạo cái mới rồi chuyển sang.

1. **Neon:** tạo project mới, region **AWS Asia Pacific (Singapore)**, rồi lấy 2 chuỗi kết nối như §8.1.
   - Dữ liệu phòng cũ không quan trọng thì bỏ qua bước chuyển dữ liệu: server tự tạo bảng khi khởi động.
   - Muốn giữ dữ liệu, chạy trên máy của bạn (dán chuỗi **không có** `-pooler`, không gửi chuỗi này cho ai):
     ```bash
     export OLD_URL='postgresql://…'   # Neon cũ, chuỗi direct
     export NEW_URL='postgresql://…'   # Neon mới, chuỗi direct
     docker run --rm -e OLD_URL -e NEW_URL postgres:17-alpine sh -c \
       'pg_dump "$OLD_URL" --no-owner --no-acl -Fc | pg_restore --no-owner --no-acl -d "$NEW_URL"'
     ```
2. **Render:** *New → Blueprint*, chọn repo `music-room-server`, nhánh `develop`. `render.yaml` tạo service `music-room-api` ở **Singapore**. Nhập các biến ở §8.2, dùng chuỗi Neon mới, và chép `YOUTUBE_API_KEY` từ service cũ. `JWT_SECRET` mới được tự sinh, nên mọi người phải nhập lại tên khi vào phòng.
3. Mở `https://<api-mới>.onrender.com/api/health`, phải thấy `"db":"up"`.
4. **Vercel:** đổi `NEXT_PUBLIC_SERVER_URL` sang địa chỉ API mới rồi **Redeploy**.
5. Đổi biến `KEEP_AWAKE_URL` ở §8.7 sang địa chỉ mới.
6. Dùng ổn vài ngày thì xóa service Render cũ và project Neon cũ.

### 8.7 Giữ API luôn thức (miễn phí)

Workflow [`.github/workflows/keep-awake.yml`](../.github/workflows/keep-awake.yml) gọi `/api/health` mỗi 10 phút nên Render không ngủ. Một service chạy cả tháng mất khoảng 744 giờ, nằm trong 750 giờ miễn phí mỗi tháng. Nếu có thêm service free thứ hai chạy liên tục thì sẽ vượt hạn mức.

1. *GitHub → repo → Settings → Secrets and variables → Actions → Variables*: tạo `KEEP_AWAKE_URL` = `https://<api>.onrender.com` (không có `/` ở cuối).
2. Workflow theo lịch chỉ chạy từ **nhánh mặc định** của repo, nên file này phải có trên nhánh đó.
3. GitHub tự tắt workflow theo lịch nếu repo công khai không có hoạt động nào trong 60 ngày. Khi đó vào tab *Actions* bật lại.

Kiểm tra: tab *Actions → keep-awake → Run workflow* chạy tay một lần, bước *Ping* phải xanh.

### 8.8 Tên miền riêng cho web (ví dụ `musicroom.io.vn`)

Bản đang chạy dùng `https://musicroom.io.vn` cho web và `https://api.musicroom.io.vn` cho API (§8.9). Tên miền riêng cho web cần khi gửi Google xét duyệt "Nhập từ YouTube", và dễ nhớ hơn `*.vercel.app`.

1. **Mua tên miền** ở một nhà đăng ký tên miền `.vn` (đuôi `.io.vn`, `.id.vn` có giá rẻ). Không cần bật DNSSEC.
2. **Vercel → Project → Settings → Domains → Add**: thêm `musicroom.io.vn` và `www.musicroom.io.vn`.
   - Chọn `musicroom.io.vn` làm tên chính; `www.musicroom.io.vn` chọn **Redirect** về `musicroom.io.vn` (308).
   - Sửa domain `<app>.vercel.app` có sẵn thành **Redirect** về `musicroom.io.vn`, để chỉ còn một địa chỉ.
3. **DNS** (ở nhà đăng ký, hoặc ở Cloudflare nếu đã chuyển nameserver như §8.9), đúng giá trị Vercel hiển thị trong trang Domains:

   | Loại | Tên | Giá trị (10/2026) |
   |---|---|---|
   | `A` | `@` | `216.198.79.1` |
   | `CNAME` | `www` | dạng `….vercel-dns-017.com.` (mỗi project một giá trị) |

   Chờ Vercel báo *Valid Configuration* (vài phút đến vài giờ); chứng chỉ HTTPS được cấp tự động.
4. **Biến môi trường**:
   - Vercel: `PUBLIC_APP_URL=https://musicroom.io.vn`, rồi **Redeploy**. `NEXT_PUBLIC_SERVER_URL` giữ nguyên.
   - Render: `PUBLIC_URL=https://musicroom.io.vn`, `CORS_ORIGINS=https://musicroom.io.vn,https://<app>.vercel.app` (giữ domain cũ để các tab đang mở ở địa chỉ cũ vẫn kết nối được cho tới khi tải lại trang). Lưu (*Save and deploy*) để Render khởi động lại với biến mới.
5. **Google** (nếu dùng đăng nhập Google):
   - [Search Console](https://search.google.com/search-console): thêm property **Domain** `musicroom.io.vn`, xác minh bằng bản ghi `TXT` (`google-site-verification=…`) ở nhà đăng ký. Dùng tài khoản Google là Owner/Editor của project chứa OAuth client.
   - OAuth client → **Authorized JavaScript origins**: thêm `https://musicroom.io.vn`.
   - **Google Auth Platform → Branding**: trang chủ `https://musicroom.io.vn`, chính sách `https://musicroom.io.vn/privacy`, điều khoản `https://musicroom.io.vn/terms`, **Authorized domains** `musicroom.io.vn`.
6. **Kiểm tra**:
   ```bash
   curl -sI https://www.musicroom.io.vn | grep -i location          # → https://musicroom.io.vn/
   curl -sI https://<app>.vercel.app | grep -i location             # → https://musicroom.io.vn/
   curl -s https://api.musicroom.io.vn/api/health                   # "db":"up", contractsVersion khớp web
   curl -s -o /dev/null -D - -H "Origin: https://musicroom.io.vn" \
     "https://api.musicroom.io.vn/socket.io/?EIO=4&transport=polling" | grep -i access-control-allow-origin
   ```
   Lệnh cuối phải in `access-control-allow-origin: https://musicroom.io.vn`; thử với một `Origin` lạ thì không in gì.

Lưu ý: dữ liệu lưu trên trình duyệt (phiên vào phòng, tên đã dùng, Yêu thích của khách) gắn với từng địa chỉ web. Sau khi chuyển tên miền, khách vào lại phòng bằng đúng tên cũ (§1); ai đăng nhập Google thì không mất gì.

### 8.9 Tên miền riêng cho API (`api.musicroom.io.vn`)

Bản đang chạy (10/2026): tên miền đăng ký ở **Mắt Bão**, DNS quản lý ở **Cloudflare** (gói Free) để
nhiều người cùng quản trị (*Cloudflare → Manage account → Members → Invite*, không chia sẻ mật khẩu).

1. **Cloudflare → Add a site** `musicroom.io.vn`, gói Free, *Import DNS records: Automatic*. Đối chiếu
   đủ bản ghi: `A @ 216.198.79.1`, `CNAME www → ….vercel-dns-017.com`, `TXT @ google-site-verification=…`.
   **Proxy status = DNS only** (đám mây xám) cho mọi bản ghi trỏ tới Vercel / Render — bật proxy dễ
   gây lỗi chứng chỉ và WebSocket.
2. Thêm `CNAME api → <api>.onrender.com` (bản đang chạy: `music-room-api-gp18.onrender.com`), DNS only.
3. **Mắt Bão → tên miền → tab Name Server** (không phải tab *Bản ghi DNS*) → *Name Server tùy chỉnh*:
   hai nameserver Cloudflare cấp (bản đang chạy: `felipe.ns.cloudflare.com`, `maxine.ns.cloudflare.com`).
   Tắt DNSSEC trước nếu đang bật. Cập nhật ở `.vn` mất vài phút tới 24 giờ; kiểm tra:
   `dig +trace NS musicroom.io.vn` phải ra nameserver Cloudflare.
4. **Render → service → Settings → Custom Domains → Add** `api.musicroom.io.vn` → *Verify*; HTTPS tự cấp.
5. **Vercel**: `NEXT_PUBLIC_SERVER_URL=https://api.musicroom.io.vn` (và `INTERNAL_SERVER_URL` nếu có),
   rồi **Redeploy** (biến `NEXT_PUBLIC_` nhúng lúc build). Render không cần đổi `PUBLIC_URL` /
   `CORS_ORIGINS` (đó là địa chỉ web). Google đăng nhập không cần đổi gì.
6. **Slack** (§9): URL trong *App Manifest* sang `https://api.musicroom.io.vn/api/slack/...`;
   **GitHub** biến `KEEP_AWAKE_URL` (§8.7) có thể đổi sang `https://api.musicroom.io.vn`.

Địa chỉ `<api>.onrender.com` cũ vẫn chạy song song, nên chuyển dần không làm gián đoạn ai. Kiểm tra
như bước 6 của §8.8.

## 9. Bot Slack `/music` (không bắt buộc)

Thêm bài, bỏ phiếu qua bài và thả reaction ngay trong Slack; bot tự đăng thẻ bỏ phiếu ✅ / ❌ (có
đếm ngược) vào kênh khi có người muốn qua bài, dù người đó bấm trên web hay trên Slack.

1. **Tạo app:** https://api.slack.com/apps → *Create New App* → *From an app manifest* → chọn
   workspace → dán [`deploy/slack/manifest.yaml`](slack/manifest.yaml). Nếu API của bạn không ở
   `api.musicroom.io.vn`, sửa ba URL trong file trước khi dán. Đã tạo app từ manifest
   cũ (chưa có `@Music Room` hoặc tab Home)? Vào *App Manifest*, dán lại file này, *Save*, rồi
   *Reinstall to Workspace* nếu Slack yêu cầu.
2. **Cài vào workspace:** *Install App* → *Install to Workspace* → cho phép. (Workspace có duyệt app
   thì admin Slack phải duyệt.)
3. **Lấy 2 giá trị**, dán vào Render → *Environment* rồi lưu (Render khởi động lại):
   - `SLACK_BOT_TOKEN`: *OAuth & Permissions* → *Bot User OAuth Token* (`xoxb-…`);
   - `SLACK_SIGNING_SECRET`: *Basic Information* → *App Credentials* → *Signing Secret*.
4. **Nối kênh với phòng:** trong kênh muốn dùng, quản trị viên phòng gõ
   `/music connect <MÃ PHÒNG> <PIN quản trị>`. Kênh riêng tư thì mời bot vào trước (`/invite @Music Room`).
   **Chỉ gõ PIN bằng `/music`** (người khác không thấy); tin nhắn tag `@Music Room` ai cũng đọc được,
   nên bot từ chối `connect` / `disconnect` qua tag.

| Lệnh | Tác dụng |
|---|---|
| `/music` | Thẻ "Đang phát" trong kênh: ❤️ 🔥 👏, ⏭ Qua bài, 🎧 Nghe cùng |
| `/music add <tên bài hoặc link>` | Link thì thêm luôn; tên bài thì hiện 3 kết quả (chỉ mình thấy) để bấm **Thêm** |
| `/music skip` | Bỏ phiếu qua bài (mở cuộc bỏ phiếu nếu chưa có) |
| `/music queue` | 5 bài tiếp theo |
| `/music disconnect <PIN>` | Bỏ nối kênh |
| `@Music Room <lệnh>` | Như `/music <lệnh>` nhưng gõ được cả **trong thread** (Slack không cho gõ `/music` trong thread); bot trả lời ngay trong thread đó |
| `@Music Room here` trong một thread | Thẻ bỏ phiếu được đăng **vào thread đó** thay vì kênh chính (kênh phải đã nối). `/music here` ở kênh để đưa về kênh |
| `@Music Room <câu nói>` hoặc `/music <câu nói>` | Hỏi **DJ** bằng câu tự nhiên, như `@DJ` trong phòng: "thêm 3 bài của Sơn Tùng", "skip giúp tôi", "xoá hết bài của tôi trừ bài của J97", "lưu bài này vào playlist Chill". Slack không có nút "Chỉ cho tôi" nên việc đơn (bỏ qua, tạm dừng, lưu…) được làm luôn; câu hỏi cách dùng thì DJ trả lời bằng chữ. Việc làm thay đổi phòng được đăng công khai, còn lại chỉ người hỏi thấy |
| Tab **Home** của app Music Room | Trang riêng của mỗi người: bài đang phát (thanh tiến độ, ❤️ 🔥 👏, ⏭ Qua bài, 🎧 Nghe cùng), bỏ phiếu ✅ / ❌, 5 bài tiếp theo, ai đang trong phòng, nút **➕ Thêm bài** (dán link hoặc tìm theo tên). Workspace nối nhiều phòng thì chọn phòng ở đầu trang |

Ghi chú:
- Người dùng Slack trở thành thành viên của phòng: trùng email với tài khoản Google đã vào phòng thì
  là chính người đó, nếu không thì một thành viên mang tên Slack. Giới hạn số bài chờ vẫn áp dụng.
- Ai bỏ phiếu qua Slack được tính là người tham gia cuộc bỏ phiếu đó (cả vào tổng số người).
- Slack cần phản hồi trong 3 giây: giữ API luôn thức (§8.7). Ngay sau khi Render ngủ dậy, lệnh đầu
  tiên có thể báo hết giờ — gõ lại là được.
- Tìm bài bằng tên tốn lượt tìm YouTube như trên web.
- Tab Home được vẽ lại khi mở tab, khi bấm **Làm mới**, và tự động khi đổi bài / có bỏ phiếu / hàng
  chờ đổi — cho ai đã mở tab trong 30 phút gần nhất (tối đa 40 người mỗi phòng). Thanh tiến độ là
  vị trí lúc vẽ, không chạy theo giây. Mọi người trong workspace xem được các phòng đã nối với kênh
  của workspace đó.

## Bản quyền

Music Room chỉ nhúng trình phát YouTube chính thức. Người cài đặt chịu trách nhiệm về bản quyền âm nhạc khi phát nhạc nơi công cộng hoặc trong văn phòng.

---

### English summary

`cp .env.example .env`, set `PUBLIC_URL` (LAN address) and optionally `YOUTUBE_API_KEY`, then run `docker compose up -d`. Open `PUBLIC_URL` to create a room, and open `PUBLIC_URL/r/<CODE>/host` on the computer connected to the speaker. Backups are plain `pg_dump`. Updates are `docker compose pull && docker compose up -d`.
