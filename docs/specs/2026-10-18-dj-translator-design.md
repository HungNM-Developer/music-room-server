# DJ "dịch câu → hành động": AI hiểu, server làm

Ngày: 2026-10-18 · Server + client · Contracts: đổi (`DjReply`, thêm bước playlist / gợi ý) · Migration: không
Nối tiếp: `2026-10-18-dj-chat-design.md` (gọi DJ, hiển thị, Slack, "Chỉ cho tôi" giữ nguyên trừ chỗ ghi ở đây).
Bản thử đo (bỏ đi, không nằm trong repo): 24 câu × Gemini `gemini-flash-lite-latest` / Groq `qwen3.8-27b`.

## Vì sao

DJ hiện tại chạy **bộ luật bắt chữ trước**, AI chỉ được hỏi khi luật bó tay. Luật thường tự tin ra
một kế hoạch sai, nên AI không bao giờ được gọi. Bốn câu người dùng thử trên production đều hỏng:

| Câu | DJ hiện tại | Đúng ra |
|---|---|---|
| `@dj thêm nhạc của jack j97` | thêm 1 bài top | thêm bài của Jack - J97 |
| `@dj gợi ý bài hát của j97` | luật không hiểu → AI → **thêm thẳng** | chỉ gợi ý, không thêm |
| `@dj xoá hết bài tôi đã chọn, chỉ chừa bài của j97` | xoá bài có **tên** "chỉ chừa bài của j97" → không xoá gì | xoá bài của tôi, giữ bài của J97 |
| `@dj xoá toàn bộ bài của tôi trừ bài của j97` | giữ bài có **tên** "của j97" → xoá hết | như trên |

Gốc lỗi: luật không phân biệt "của X" là người chọn hay ca sĩ, không biết "chừa / giữ lại", không có
hành động "gợi ý", và không biết khi nào mình không chắc.

## Mục tiêu

- **AI đọc câu trước**, dịch thành một **khung hành động cố định** (JSON). AI **không** chọn bài, không
  biết hàng chờ, không gọi YouTube, không tự làm gì.
- **Server làm phần thật**: tra ca sĩ / bài bằng InnerTube (YouTube Music), lọc hàng chờ theo người
  chọn / ca sĩ chuẩn / tên bài / vị trí / điều kiện giữ lại, kiểm tra quyền người hỏi, thực hiện,
  rồi trả lời đã làm gì.
- **Bộ luật chỉ còn lo câu cực ngắn và chắc chắn** (xem "Luật nhanh"), để tiết kiệm lượt AI và chạy được
  khi AI không dùng được.
- Thêm **gợi ý** (chỉ đưa danh sách, không thêm), **loại trừ khi thêm**, **đổi bài A thành B**.
- Thêm **3 việc với playlist cá nhân** của người hỏi: lưu bài đang phát vào playlist, tạo playlist mới,
  đưa cả playlist vào hàng chờ.
- Câu **không liên quan** tới app: DJ đáp lại **hài hước và đa dạng** (không lặp một câu).
- **DJ làm luôn cả việc đơn** người dùng tự bấm được (skip, tạm dừng, phát tiếp, thả tim, xoá, ghim, lưu
  bài…), theo đúng quyền người hỏi (người dùng chọn, 2026-10-18; thay quy tắc "việc đơn thì chỉ nút" của
  `2026-10-18-dj-chat-design.md`). Chỉ **câu hỏi cách dùng** ("lời bài hát ở đâu", "chia sẻ phòng sao",
  "làm sao chặn bài") mới trả lời bằng "Chỉ cho tôi".

## Không làm

- Không xoá gì trong playlist, không đổi tên / xoá / chia sẻ playlist qua DJ.
- Không đụng playlist của người khác (kể cả playlist được chia sẻ bằng link).
- Không nhớ ngữ cảnh hội thoại (giữ như bản trước): mỗi `@DJ` là một yêu cầu độc lập.
- Không đổi cài đặt phòng, quyền, mời ra, chặn bài, xoá phòng qua DJ (giữ như bản trước).
- Không AI trả phí, không tool-calling. Tối đa **một lần gọi AI cho mỗi yêu cầu** (giữ như bản trước).

## Thất bại (người dùng định nghĩa)

Dù chạy đúng kỹ thuật, những điều sau là **thất bại**:

1. **Thêm sai bài**: sai ca sĩ, sai bài, bản cover / reaction / karaoke khi người hỏi không xin.
2. **Xoá nhầm bài**: xoá bài người hỏi muốn giữ, hoặc bài không thuộc phạm vi họ nói.
3. **Không tìm được bài** mà bài đó có thật trên YouTube: đã có InnerTube thì phải tìm ra.

Hệ quả cho thiết kế:

- **Xoá chỉ khi chắc chắn.** Bài nào không xác định được có thuộc điều kiện "giữ lại" hay không (ví dụ chưa
  biết ca sĩ) thì **giữ lại** và nói rõ trong câu trả lời. Phạm vi xoá mơ hồ ("xoá bớt đi") → hỏi lại,
  không đoán.
- **Thêm chỉ khi khớp.** Bài tìm được phải khớp ca sĩ chuẩn (khi người hỏi nói ca sĩ) và khớp tên bài
  (khi người hỏi nói tên). Không khớp → thử kết quả kế tiếp / cách tìm khác; hết cách → nói không tìm
  thấy kèm gợi ý ô tìm bài, **không** thêm bài "gần giống".
- **Tìm nhiều đường trước khi bỏ cuộc** (xem "Tìm bài").

## Luồng xử lý

1. **Luật nhanh** (không gọi AI). Chỉ nhận câu mà **mọi từ** đều thuộc một mẫu ngắn đã biết (sau khi bỏ
   lời đệm "giúp tôi", "đi", "nhé", "với"…):
   - bỏ qua / skip / next / qua bài; bỏ qua N bài → **làm luôn** (có quyền điều khiển: chuyển ngay; không:
     mở / bỏ phiếu bỏ qua);
   - tạm dừng / dừng / pause; phát tiếp / resume → làm luôn (cần quyền điều khiển, không có thì nói rõ);
   - lưu bài này / save (không nêu playlist) → làm luôn: **Lưu** bài đang phát (như nút Lưu);
   - (thả tim chỉ áp dụng bài trong hàng chờ nên luôn đi AI để biết bài nào);
   - bài đang phát là gì; ai chọn bài này; bao giờ tới bài của tôi; hàng chờ còn mấy bài; tôi đã thêm mấy bài;
   - câu hỏi cách dùng đã có mẫu trong luật hiện tại (lời bài hát, nghe cùng, chia sẻ / QR, thu nhỏ, chặn
     bài…) → "Chỉ cho tôi" như cũ;
   - chào / cảm ơn.
   Còn sót bất kỳ từ nào luật không hiểu → **không đoán**, chuyển sang AI. Bộ luật combo hiện tại
   (`dj-plan.ts`) **không còn quyết định** khi AI dùng được.
2. **AI dịch** (một lần gọi; Gemini trước, Groq rồi OpenRouter dự phòng, chuỗi `AiService` sẵn có).
   Gửi: hướng dẫn cố định + `{ asker, members: [tên các thành viên đang hoạt động], text }`.
   **Không** gửi hàng chờ hay thư viện bài. Nhận: `{ "steps": [...] }` theo khung dưới.
3. **Kiểm tra khung** (server, thuần): bước sai khung / mã lạ → bỏ bước đó; mọi bước bị bỏ → coi như
   `chat`. Bước `remove` không có phạm vi rõ (không `scope`, không tên, không vị trí) → đổi thành `clarify`.
4. **Giải nghĩa** (server): ca sĩ → tên chuẩn (InnerTube); tên người → thành viên; mục tiêu → các bài
   trong hàng chờ; playlist → playlist của người hỏi.
5. **Thực hiện** từng bước theo thứ tự, mỗi bước qua đúng service của web với actor là người hỏi; bước
   lỗi không chặn bước sau (giữ như combo hiện tại).
6. **Trả lời** một tin DJ có cấu trúc (`DjReply`), client viết thành câu theo ngôn ngữ người xem.

**AI không dùng được** (hết lượt người hỏi, mọi nhà cung cấp nghỉ / lỗi / quá giờ): câu đã qua luật nhanh
vẫn chạy; câu khác → DJ báo chưa hiểu + 2–3 cách nói ngắn mẫu. **Không** dùng bộ luật combo cũ để đoán
lệnh xoá. Bộ luật combo cũ được phép dùng làm dự phòng **chỉ cho bước thêm / gợi ý / thông tin**
(quyết định của tôi; builder có thể bỏ hẳn nếu đơn giản hơn).

## Khung hành động (AI trả về)

Đã thử với bản thử đo; builder được chỉnh tên trường nhưng giữ đủ ý.

```
steps[i] là một trong:
{ do: "add",      find: F, count?: 1-5, pin?: "next"|"now", wish?: string }
{ do: "suggest",  find: F, count?: 1-5 }                      // chỉ đưa danh sách, không thêm
{ do: "remove" | "heart" | "pin" | "skipTo", target: T }      // pin = phát kế tiếp; skipTo = chuyển ngay
{ do: "replace",  target: T, find: F }                        // đổi bài A (trong hàng chờ) thành B
{ do: "skip", count?: n } | { do: "pause" } | { do: "resume" }
{ do: "info",  about: "now"|"next"|"queue"|"mine"|"when_mine"|"who_picked" }
{ do: "save" }                                                // Lưu bài đang phát (bài đã lưu)
{ do: "guide", topic: <một mã GuideTarget> }                  // chỉ cho câu hỏi CÁCH dùng
{ do: "playlistSave",   playlist: string }                    // lưu bài đang phát vào playlist
{ do: "playlistCreate", name: string, find?: F, count?: 1-5 } // tạo playlist mới, có thể kèm bài
{ do: "playlistPlay",   playlist: string }                    // đưa cả playlist vào hàng chờ
{ do: "clarify", about: "removeScope"|"whichSong"|"whichPlaylist"|... } // câu mơ hồ
{ do: "chat",  reply: string }                                // chào hỏi / không liên quan: câu đáp hài hước

F (tìm trên YouTube): { titles?: string[], artist?: string,
                        mode?: "top"|"latest"|"popular"|"similar_now"|"mood", mood?: string,
                        picks?: [{ artist, song }] (chỉ khi mode = "mood"; server kiểm chứng),
                        exclude?: { titles?: string[], artist?: string } }
T (bài trong hàng chờ): { scope: "all"|"mine"|"others"|"member", member?: string,
                          artist?: string, titles?: string[],
                          positions?: number[] (1 = bài kế, -1 = bài cuối), first?: n, last?: n,
                          keep?: { artist?: string, titles?: string[], member?: string } }
```

Quy ước dạy AI (trong hướng dẫn cố định):
- "của X": X là tên thành viên → người chọn (`member`); không phải → ca sĩ (`artist`).
- "chừa", "giữ lại", "trừ", "ngoại trừ", "để lại" → `keep`; "đừng thêm", "trừ bài" khi thêm → `exclude`.
- "gợi ý", "có bài nào", "nên nghe gì" → `suggest`; "cho / bật / thêm / mở" → `add`.
- `count` mặc định 1; "vài / mấy" = 3; "nhiều" = 5; xin hơn 5 → ghi đúng số xin (server cắt và nói rõ).
- Lời chúc / tặng ai → `wish` trên bước `add` đầu tiên.
- AI **không viết câu trả lời**, trừ `chat.reply` (xem "Câu không liên quan").
- Câu hỏi **cách** làm ("làm sao…", "ở đâu", "how do I") → `guide`; câu **nhờ làm** → bước hành động.

## Giải nghĩa và thực hiện

**Ca sĩ chuẩn.** `artist` từ AI → YouTube Music tìm nghệ sĩ (InnerTube, `music.search(type: 'artist')`),
lấy kết quả đầu nếu tên khớp đủ (bản thử: "j97" / "jack j97" → "Jack - J97", "Sơn Tùng" → "Sơn Tùng M-TP",
"Đen Vâu" → "Đen"). Ghi nhớ trong bộ nhớ đệm (tên gõ → tên chuẩn + bí danh) để lần sau không tra lại.
Tra lỗi → dùng nguyên chữ người gõ, và với lệnh **xoá có `keep.artist`** thì coi mọi bài "không chắc" là giữ.

**So bài trong hàng chờ với ca sĩ.** Một bài thuộc ca sĩ khi tên chuẩn hoặc bí danh (tách theo " - ", "&",
"ft.", "x") khớp `Track.artistKey`, hoặc kênh, hoặc tiêu đề (chuẩn hoá bỏ dấu). Bài chưa có `artistKey`
(worker metadata chưa chạy) và kênh / tiêu đề không khớp rõ → **không chắc**.

**Tìm bài (add / suggest / replace / playlistCreate).** Thứ tự, dừng ở bước đầu cho đủ bài khớp:
1. Thư viện phòng (`findKnown`) khi có tên bài + ca sĩ.
2. YouTube Music tìm **bài hát** (`music.search(type: 'song')`) với "tên bài ca sĩ" hoặc ca sĩ chuẩn → có
   sẵn tên bài, ca sĩ, videoId chuẩn.
3. InnerTube tìm **video** ("ca sĩ tên bài", rồi thêm "MV" / "Official"), lọc như luật "bài mới" hiện có
   (1–10 phút, kênh nghệ sĩ / official, bỏ reaction / cover / karaoke / tổng hợp khi người hỏi không xin).
4. `SearchService.search` (Data API) khi InnerTube lỗi.
`mode`: `top` / `popular` → bài phổ biến của ca sĩ; `latest` → như luật "bài mới" hiện có; `similar_now` →
"Phát tiếp" của YouTube (`upNext`) từ bài đang phát; `mood` → trong **cùng lần gọi** AI trả thêm
`picks: [{artist, song}]` (tối đa 5, bài có thật hợp tâm trạng); server **kiểm chứng từng bài** bằng YouTube
Music tìm bài hát (tên bài và ca sĩ phải khớp), bài không khớp thì bỏ; không còn bài nào → tìm YouTube Music
bài hát với "<tâm trạng>" (không nhận video tổng hợp / mix). Đây là ngoại lệ duy nhất AI nêu tên bài, và
không bao giờ được thêm khi chưa kiểm chứng (quyết định của tôi). `exclude` bỏ các bài trùng tên / ca sĩ đó.
Mỗi bài thêm vẫn qua `QueueService.add` (giới hạn mỗi người, bị chặn, vừa phát, quá dài…); bài lỗi thì
thử ứng viên kế (tối đa 5 ứng viên mỗi bài như hiện tại).

**Xoá / tim / ghim / chuyển.** Lọc hàng chờ (thứ tự `orderQueue`): `scope` → `member` / `artist` / `titles`
→ bỏ các bài khớp `keep` (và bài "không chắc" khi `keep` theo ca sĩ) → vị trí (`positions` / `first` / `last`).
Quyền như combo hiện tại: xoá bài của mình (quản trị viên: mọi bài); ghim / chuyển cần quyền điều khiển;
tim theo luật một tim mỗi người. **Xoá trong hàng chờ làm luôn, không xác nhận.** Không bài nào khớp →
nói "không có bài nào khớp", không xoá gì.

**Playlist** (cần đăng nhập; khách → câu nhắc đăng nhập; Slack → làm được nếu người hỏi Slack đã nối với
tài khoản, không thì nhắc mở web):
- `playlistSave`: tìm playlist của người hỏi theo tên (chuẩn hoá bỏ dấu, khớp gần đúng). Không có →
  **tạo mới tên đó rồi lưu**, báo rõ "đã tạo playlist X". Nhiều playlist khớp ngang nhau → `clarify`
  kèm danh sách tên. Không có bài đang phát → nói rõ.
- `playlistCreate`: tạo bằng `PlaylistsService.create`; có `find` thì tìm bài như trên rồi thêm vào
  playlist (không thêm vào hàng chờ). Trùng tên playlist đã có → dùng playlist đó, báo rõ.
- `playlistPlay`: playlist của người hỏi theo tên → `QueueService.addMany` theo thứ tự (giới hạn mỗi người
  sẵn có cắt bớt; báo đã thêm N / M bài và lý do dừng). Không tìm thấy playlist → `clarify` kèm tên các
  playlist người hỏi có.

**Gợi ý (`suggest`).** Tìm như "Tìm bài" (tối đa `count`, mặc định 3), **không thêm**. Câu trả lời là danh
sách thẻ bài; **mỗi thẻ có nút "Thêm"** cho ai trong phòng bấm cũng được, thêm bằng quyền của người bấm
(quyết định của tôi).

## Câu không liên quan (`chat`)

Người dùng chọn (2026-10-18): **AI viết câu đáp** — ngoại lệ duy nhất cho quy tắc "chữ do AI viết không
hiện thẳng" của bản trước.
- Có trong **cùng lần gọi** dịch câu (`{do:"chat", reply}`), không tốn thêm lượt. Hướng dẫn cố định yêu
  cầu: một câu ngắn, hài hước, thân thiện, hợp văn phòng, đúng ngôn ngữ người hỏi, có thể lái về âm nhạc /
  gợi ý thử `@DJ`; không chính trị, tôn giáo, tình dục, xúc phạm, không đưa thông tin y tế / tài chính.
- Server: cắt tối đa 200 ký tự, qua bộ lọc từ cấm sẵn có (`maskBlocked` / moderation); bị lọc hoặc rỗng →
  dùng câu mẫu.
- **Câu mẫu dự phòng** (AI không dùng được / hết lượt / bị lọc): kho ~30 câu hài viết sẵn (vi + en), chọn
  ngẫu nhiên, không lặp câu vừa dùng trong phòng.
- `DjReply` lưu nguyên câu đã duyệt (`chatReply`); mọi người xem cùng một câu (không dịch theo người xem).
  Slack đăng y như vậy (trả lời riêng như `other` hiện tại).
- Lời chào thuần ("chào DJ", "cảm ơn") vẫn đi luật nhanh với câu chào có sẵn.

## Trả lời (`DjReply`)

Mở rộng `kind: 'done'` của combo: mỗi bước có kết quả (đã làm / không làm + lý do), cộng các loại mới:
- `suggested`: danh sách `TrackSummary` + nút "Thêm".
- `removed`: số bài đã xoá + tên; số bài **đã giữ lại** vì điều kiện `keep` hoặc vì "không chắc" (tên bài).
- `playlist`: tên playlist, đã tạo mới hay chưa, số bài đã lưu / đã đưa vào hàng chờ.
- `clarify`: mã câu hỏi + lựa chọn (tên playlist, …); client viết câu hỏi lại.
- `chat`: câu đáp đã duyệt (`chatReply`).
- `done` cho việc đơn (skip, tạm dừng, thả tim, lưu, xoá một bài…): một dòng "đã làm X" (bài, người, số
  bài); không làm được → lý do theo mã lỗi sẵn có.
Câu trả lời luôn ghi **tên ca sĩ chuẩn** đã hiểu ("bài của Jack - J97") để người hỏi thấy DJ hiểu đúng.

## Trạng thái biên

- AI trả `remove` + `keep` nhưng hàng chờ không có bài nào của người hỏi → "Bạn chưa có bài nào đang chờ".
- Tất cả bài khớp phạm vi đều thuộc `keep` → "Không có bài nào cần xoá, đã giữ N bài của X".
- Người hỏi gõ tên thành viên trùng tên ca sĩ → ưu tiên thành viên (như hướng dẫn AI); câu trả lời nêu rõ.
- InnerTube nghỉ (sau 3 lỗi liên tiếp, 30 phút) → bước 2–3 của "Tìm bài" bỏ qua, dùng Data API.
- Người hỏi rời phòng / bị mời ra trong lúc DJ xử lý → bỏ kết quả (giữ như bản trước).
- Hai `@DJ` liền nhau của cùng người → tuần tự (giữ như bản trước).

## Lượt AI và chi phí (đo trên bản thử)

- ~555–590 token vào (hướng dẫn cố định ~523) + 10–120 token ra mỗi câu; Gemini 0,6–1,2 s, Groq 0,4–2,5 s.
- Tra ca sĩ YouTube Music 0,4–0,7 s, không tốn lượt AI.
- Giữ `DJ_AI_PER_HOUR` (mặc định 10 / người / giờ); câu qua luật nhanh không tính lượt; AI lỗi thì trả lượt.
- Gemini là nhà cung cấp đầu (chính xác hơn trong bản thử), Groq dự phòng.

## Kiến trúc (định hướng)

- `src/dj/dj-translate.ts` (thuần): hướng dẫn cố định cho AI + kiểm tra / chuẩn hoá khung.
- `src/dj/dj-resolve.ts`: ca sĩ chuẩn (bộ nhớ đệm), so bài với ca sĩ, lọc mục tiêu hàng chờ.
- Mở rộng `InnerTubeProvider`: `musicArtist(name)`, `musicSongs(query, max)`.
- `DjBrainService`: luật nhanh → AI dịch → giải nghĩa → thực hiện; `DjComboService` dùng lại cho phần thực
  hiện các bước hàng chờ / máy phát. Bỏ việc đổi hành động đơn thành chỉ dẫn (`guideOfAiPlan`).
- Playlist qua `PlaylistsService` (`mine`, `create`, `setTrack`) và `QueueService.addMany`.
- Contracts: `DjReply` thêm loại / trường mới; bump `CONTRACTS_VERSION` (fetch `origin/develop` trước).
- Client: thẻ gợi ý có nút "Thêm", câu trả lời "đã xoá / đã giữ", "playlist", "hỏi lại", i18n vi + en.

## Để builder quyết

- Câu chữ hướng dẫn cố định cho AI (miễn giữ quy ước ở trên và ≤ ~700 token).
- Ngưỡng "khớp đủ" khi so tên ca sĩ / tên bài / tên playlist.
- Danh sách mẫu của luật nhanh và lời đệm.
- Cách vẽ thẻ gợi ý và câu "đã giữ lại" (miễn đạt WCAG AA, biểu tượng lucide).

## Kiểm thử

Không có test tự động (quy ước dự án). Mỗi task: lint + typecheck server và client, build client (không
chạy song song nest watch). Thử trên dev (`localhost:55432`) với **bộ 27 câu bên dưới** (gồm 4 câu người
dùng), ghi kết quả từng câu (hiểu thành gì, làm gì) vào ghi chú PR. Tiêu chí: 4 câu người dùng đúng 100%;
không câu nào xoá nhầm hoặc thêm sai ca sĩ.

Bộ câu thử (người hỏi "Khanh Nguyen"; thành viên: Khanh Nguyen, Lan, Minh Anh, Tuấn) và ý đúng:

| # | Câu | Ý đúng |
|---|---|---|
| 1 | thêm nhạc của jack j97 | add, artist Jack - J97 |
| 2 | gợi ý bài hát của j97 | suggest, artist Jack - J97, không thêm |
| 3 | xoá hết bài tôi đã chọn, chỉ chừa bài của j97 | remove mine, keep artist Jack - J97 |
| 4 | xoá toàn bộ bài của tôi trừ bài của j97 | như #3 |
| 5 | thêm 3 bài mới nhất của Sơn Tùng | add 3, latest, Sơn Tùng M-TP |
| 6 | có bài nào giống bài đang phát không | suggest, similar_now |
| 7 | cho vài bài chill chill để làm việc | add 3, mood chill |
| 8 | xoá bài của Lan | remove member Lan |
| 9 | xoá bài của Lan trừ Lạc Trôi | remove member Lan, keep title Lạc Trôi |
| 10 | thả tim hết bài của Minh Anh | heart member Minh Anh (một tim: bài đầu) |
| 11 | skip đến bài cuối giúp tôi | skipTo position -1 |
| 12 | ghim bài Nơi này có anh lên tiếp theo | pin title Nơi này có anh |
| 13 | bỏ qua 2 bài rồi tạm dừng | skip 2, pause |
| 14 | thêm Hãy trao cho anh và Chúng ta của hiện tại, tặng cả phòng chúc cuối tuần vui vẻ | add 2 bài, wish |
| 15 | bài đang phát tên gì vậy | info now |
| 16 | bao giờ tới bài của tôi | info when_mine |
| 17 | làm sao để chặn một bài | guide block |
| 18 | xoá bớt đi | clarify removeScope |
| 19 | đổi bài Lạc Trôi thành Chúng ta không thuộc về nhau | replace |
| 20 | thêm bài nào đó của Đen Vâu nhưng đừng thêm Bài này chill phết | add artist Đen, exclude title |
| 21 | xoá 2 bài cuối của tôi | remove mine, last 2 |
| 22 | nay mệt quá | chat, câu đáp hài hước |
| 23 | add some taylor swift please | add 3, artist Taylor Swift |
| 24 | xoá hết bài trong hàng chờ của mọi người trừ của tôi | remove others |
| 25 | lưu bài này vào playlist Chill | playlistSave Chill |
| 26 | tạo playlist Nhạc thứ Sáu gồm 5 bài của Đen | playlistCreate + 5 bài Đen |
| 27 | phát playlist Chill | playlistPlay Chill |
| 28 | skip giúp tôi | làm luôn: chuyển bài (có quyền) / bỏ phiếu (không) |
| 29 | lưu bài này | làm luôn: Lưu bài đang phát |

## Quyết định đã chốt

Người dùng (2026-10-18):
- Xoá chỉ trong hàng chờ / máy phát, làm luôn không xác nhận; playlist không có xoá.
- Playlist: lưu bài đang phát vào playlist, tạo playlist mới, đưa cả playlist vào hàng chờ.
- Việc đơn: DJ làm luôn (theo quyền người hỏi); chỉ câu hỏi cách dùng mới "Chỉ cho tôi".
- Câu không liên quan: AI viết câu đáp hài hước (có lọc + câu mẫu dự phòng).
- Thất bại = thêm sai bài, xoá nhầm bài, không tìm được bài có thật.

Của tôi (người dùng kiểm khi đọc):
- `mood`: AI nêu tên bài trong cùng lần gọi, server kiểm chứng từng bài trên YouTube Music trước khi thêm.
- Thẻ gợi ý: nút "Thêm" ai bấm cũng được, thêm theo quyền người bấm.
- "Lưu vào playlist X" khi X chưa có: tạo mới rồi lưu, báo rõ.
- Bộ luật combo cũ chỉ làm dự phòng cho thêm / gợi ý / thông tin khi AI không dùng được; không bao giờ đoán lệnh xoá.

## Quyết định khi triển khai (2026-10-18)

- Hướng dẫn cho AI dài ~970 token vào (spec ước ~700) vì gồm thêm 6 hành động và quy tắc câu đáp.
- Bài "chưa biết ca sĩ" luôn là "không chắc" (giữ lại khi xoá có "trừ"); lọc xoá / tim theo ca sĩ chỉ dùng tên đầy đủ + chữ người gõ ("Jack" một mình có thể là Jack Harlow), còn điều kiện giữ lại dùng cả các phần tên.
- Bài YouTube Music khớp ca sĩ theo dòng nghệ sĩ được ghi công, không theo tiêu đề ("Tình Ca Măng Đen" không phải của Đen). Ứng viên trùng một bài (nhiều bản tải lên) chỉ lấy một.
- Gợi ý tối thiểu 3 bài. "mood" luôn kèm tên bài do AI nêu (kiểm chứng trên YouTube Music); thiếu thì tìm "nhạc <tâm trạng>", bỏ video tổng hợp / mix / "top…" / không lời.
- Không có AI: câu không liên quan trả "chưa giúp được" (không phân biệt được chuyện phiếm khi không có AI); câu xoá không bao giờ chạy.
- Bước "noPlaylist" có `options` (tên playlist gần đúng) để DJ hỏi lại.
