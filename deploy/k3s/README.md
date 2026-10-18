# Chạy API + PostgreSQL trên k3s (Raspberry Pi 4, 4 GB)

Mọi thứ nằm trong namespace `music-room`, nên sau này cài app khác vào namespace khác thì không đụng nhau.
Xoá sạch app: `kubectl delete namespace music-room` (mất cả dữ liệu Postgres).

| File | Nội dung |
|---|---|
| `namespace.yaml` | Namespace + `LimitRange` (resource mặc định) + `ResourceQuota` (namespace dùng tối đa ~1,5 GB RAM) |
| `configmap.yaml` | Biến không bí mật: `PUBLIC_URL`, `CORS_ORIGINS`… |
| `postgres.yaml` | Postgres 16 (StatefulSet, ổ 5 Gi qua `local-path`), chỉ truy cập trong cluster |
| `api.yaml` | API (1 replica, `Recreate`), tự chạy migration khi khởi động |
| `ingress.yaml` | Traefik (có sẵn trong k3s) mở API ra cổng 80 |

Secret **không** nằm trong git; tạo bằng lệnh ở bước 5. Setup lần đầu làm tay (bước 1–6); sau đó GitHub Actions tự cập nhật image API (bước 9).

## 1. Chuẩn bị Raspberry Pi

1. Cài **Raspberry Pi OS Lite 64-bit** (bắt buộc 64-bit, image API chỉ có `arm64`/`amd64`). Nên boot từ **SSD USB** thay vì thẻ SD: Postgres ghi liên tục sẽ làm thẻ SD nhanh hỏng.
2. Đặt IP tĩnh cho Pi (trong router, DHCP reservation), ví dụ `192.168.1.50`.
3. Bật cgroup memory (k3s cần). Thêm vào **cuối dòng duy nhất** của `/boot/firmware/cmdline.txt` (không xuống dòng):

   ```
    cgroup_memory=1 cgroup_enable=memory
   ```

   rồi `sudo reboot`. Kiểm tra: `cat /sys/fs/cgroup/cgroup.controllers` phải có `memory` (đã có sẵn thì bỏ qua bước này).
4. **Tắt Overlay File System** nếu đang bật: `findmnt -no FSTYPE /` phải ra `ext4`. Nếu ra `overlay`, mọi thứ ghi xuống đĩa chỉ nằm trong RAM và mất khi reboot (k3s sẽ báo `"overlayfs" snapshotter cannot be enabled`); sửa `cmdline.txt` cũng báo `Read-only file system`. Cách tắt:
   ```bash
   sudo raspi-config nonint disable_overlayfs
   grep -o 'overlayroot=[^ ]*' /boot/firmware/cmdline.txt || echo OK   # còn thì: remount rw rồi xoá tham số đó
   sudo reboot
   sudo raspi-config nonint disable_bootro    # sau reboot: bỏ khoá ghi /boot/firmware
   ```
   Cài k3s **sau** khi đã tắt overlay (bản cài trong overlay mất khi reboot).

## 2. Cài k3s

```bash
curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644
kubectl get nodes          # STATUS = Ready sau khoảng 1 phút
```

k3s cài sẵn: Traefik (ingress, cổng 80/443), ServiceLB, `local-path` storage, `kubectl`.

Mọi lệnh `kubectl` bên dưới chạy **ngay trên Pi** (qua SSH/Termius): k3s đã cấu hình sẵn `kubectl` trên Pi, không cần cài hay tải gì về máy khác.

## 3. Đưa file lên Pi

```bash
git clone https://github.com/HungNM-Developer/music-room-server.git
cd music-room-server/deploy/k3s
```

Cập nhật về sau: `git pull` trong thư mục đó. (Hoặc tải thư mục `deploy/k3s` lên bằng tab SFTP của Termius.)

## 4. Sửa cấu hình

Sửa bằng `nano <file>` trên Pi:

- `configmap.yaml`: `PUBLIC_URL` = địa chỉ **web** (dùng cho link và QR), `CORS_ORIGINS` = các địa chỉ web được gọi API.
- `ingress.yaml`: tên miền API (mặc định `api.musicroom.io.vn`).
- `api.yaml`: muốn cố định phiên bản thì đổi `:latest` thành tag cụ thể, ví dụ `:v1.4.0`.

## 5. Tạo namespace và Secret

```bash
kubectl apply -f namespace.yaml

PGPASS=$(openssl rand -hex 24)
kubectl -n music-room create secret generic music-room-secrets \
  --from-literal=POSTGRES_PASSWORD="$PGPASS" \
  --from-literal=DATABASE_URL="postgresql://musicroom:$PGPASS@db:5432/musicroom" \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=YOUTUBE_API_KEY= \
  --from-literal=GOOGLE_CLIENT_ID= \
  --from-literal=LASTFM_API_KEY= \
  --from-literal=GEMINI_API_KEY= \
  --from-literal=GROQ_API_KEY= \
  --from-literal=SLACK_BOT_TOKEN= \
  --from-literal=SLACK_SIGNING_SECRET=
```

Điền key nào có, để trống key không dùng. Đổi một key sau này:

```bash
kubectl -n music-room patch secret music-room-secrets \
  -p '{"stringData":{"YOUTUBE_API_KEY":"AIza..."}}'
kubectl -n music-room rollout restart deploy/api
```

> Đừng đổi `POSTGRES_PASSWORD` sau khi Postgres đã chạy lần đầu: Postgres chỉ đọc biến này lúc khởi tạo dữ liệu.

## 6. Triển khai

```bash
kubectl apply -k .
kubectl -n music-room get pods -w      # db-0 và api-… đều Running, READY 1/1
```

Lần đầu kéo image và chạy migration trên Pi mất vài phút. Kiểm tra:

```bash
kubectl -n music-room logs deploy/api -f
curl -H "Host: api.musicroom.io.vn" http://localhost/api/health    # "db":"up"
```

## 7. Ra internet (HTTPS)

Pi ở nhà thường nằm sau NAT, chọn một trong hai cách:

**A. Cloudflare Tunnel (khuyên dùng, không cần mở cổng router).** Tên miền đã ở Cloudflare (`deploy/README.md` §8.9).
1. *Cloudflare Zero Trust → Networks → Tunnels → Create tunnel* (loại Cloudflared), chọn *Debian / arm64*, chạy trên Pi đúng các lệnh Cloudflare hiển thị (cài gói `cloudflared` rồi `sudo cloudflared service install <TOKEN>`).
2. Trong tunnel, thêm *Public hostname* `api.musicroom.io.vn` → service `http://localhost:80`. Đặt host trong `ingress.yaml` đúng bằng `api.musicroom.io.vn` để Traefik nhận ra. Cloudflare tự lo HTTPS.

Một tunnel phục vụ được mọi app sau này (mỗi app một hostname, Traefik tự định tuyến theo host).

**B. Mở cổng 80/443 trên router về Pi**, trỏ bản ghi `A` về IP công cộng, rồi cài cert-manager + Let's Encrypt để có HTTPS.

Sau khi API chạy ở tên miền mới: đổi `NEXT_PUBLIC_SERVER_URL` trên Vercel rồi Redeploy, và đổi URL trong Slack manifest nếu dùng bot (`deploy/README.md` §8.9, §9).

## 8. Vận hành

| Việc | Lệnh |
|---|---|
| Xem log | `kubectl -n music-room logs deploy/api -f` |
| Cập nhật API (tag `latest`) | `kubectl -n music-room rollout restart deploy/api` |
| Cập nhật API (tag cụ thể) | `kubectl -n music-room set image deploy/api api=ghcr.io/hungnm-developer/music-room-server:v1.5.0` |
| Cập nhật manifest | `git pull && kubectl apply -k .` (trong `deploy/k3s`) |
| Sao lưu | `kubectl -n music-room exec db-0 -- pg_dump -U musicroom musicroom > backup-$(date +%F).sql` |
| Khôi phục | `kubectl -n music-room exec -i db-0 -- psql -U musicroom musicroom < backup.sql` |
| Vào psql | `kubectl -n music-room exec -it db-0 -- psql -U musicroom` |
| RAM đang dùng | `kubectl top pods -A` |
| Quota namespace | `kubectl -n music-room describe resourcequota` |

Ghi chú:
- API giữ phòng và bộ hẹn giờ trong bộ nhớ, nên **luôn chỉ 1 replica**; cập nhật sẽ ngắt kết nối vài giây rồi client tự nối lại.
- Dữ liệu Postgres nằm ở `/var/lib/rancher/k3s/storage/` trên Pi. Nên đặt cron sao lưu ra ổ khác.
- Thêm app khác: tạo namespace mới với `LimitRange` + `ResourceQuota` tương tự `namespace.yaml`. Tổng RAM: k3s ~500 MB, Music Room ~0,5–1 GB, còn lại ~2 GB cho các app khác.

## 9. Tự động cập nhật API bằng GitHub Actions

Mỗi lần push tag `v*`, `ci.yml` build image rồi job `deploy-k3s` SSH vào Pi chạy
`kubectl set image` cho API và chờ API lên lại. GitHub **chỉ đổi image**: manifest, Secret, Postgres giữ nguyên như bạn đã setup ở bước 1–6, nên GitHub không cần biết mật khẩu hay API key nào.

Cấu hình một lần:

1. **Tạo key SSH cho GitHub** (Terminal trên Mac):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/k3s-deploy -N "" -C github-actions
   cat ~/.ssh/k3s-deploy.pub
   ```
2. **Cho key đó vào Pi** (Termius), dán dòng vừa in:
   ```bash
   echo 'ssh-ed25519 AAAA… github-actions' >> ~/.ssh/authorized_keys
   ```
3. **Lấy dấu vân tay của Pi** (Terminal trên Mac), để GitHub chắc chắn đang vào đúng Pi:
   ```bash
   ssh-keyscan -t ed25519 <IP_PI> 2>/dev/null
   ```
4. **GitHub → repo → Settings → Secrets and variables → Actions**:

   | Tab | Tên | Giá trị |
   |---|---|---|
   | Variables | `K3S_HOST` | IP SSH của Pi |
   | Variables | `K3S_USER` | user SSH trên Pi |
   | Variables | `K3S_KNOWN_HOSTS` | dòng in ra ở mục 3 |
   | Variables | `K3S_SSH_PORT` | chỉ khi SSH không ở cổng 22 |
   | Secrets | `K3S_SSH_KEY` | private key: `pbcopy < ~/.ssh/k3s-deploy` rồi dán (gồm cả dòng `BEGIN`/`END`) |

   Xong thì xoá private key trên Mac: `rm ~/.ssh/k3s-deploy`.

Phát hành bản mới: `git tag v1.5.0 && git push origin v1.5.0`. Xem kết quả ở tab *Actions*; job `deploy-k3s` in danh sách pod và log ở bước *Status*.

Ghi chú:
- Sửa `configmap.yaml` / `ingress.yaml` / Secret vẫn làm tay trên Pi (bước 4–6, `git pull && kubectl apply -k .`).
- `kubectl apply -k .` đưa API về tag ghi trong `api.yaml` (`latest`, cũng là bản mới nhất). Muốn giữ đúng tag đang chạy thì sửa `api.yaml` trước khi apply.
