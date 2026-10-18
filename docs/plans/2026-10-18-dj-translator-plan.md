# DJ "dịch câu → hành động" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@DJ` hiểu câu nói thường bằng AI (một lần gọi), server tra YouTube Music / InnerTube và hàng chờ rồi tự làm (thêm, gợi ý, xoá có "giữ lại", tim, ghim, chuyển, bỏ qua, dừng, lưu, playlist), đáp câu không liên quan bằng câu hài do AI viết.

**Architecture:** Luật nhanh (`matchQuick`, 0 lần AI) → `AiService.json` với hướng dẫn dịch mới (`dj-translate.ts`) trả `steps` → `parseTranslation` kiểm khung thành `Plan` (mở rộng kiểu của `dj-plan.ts`) → `DjComboService` thực hiện từng bước, dùng `DjResolver` (ca sĩ chuẩn + lọc hàng chờ) và `DjFinder` (tìm bài 4 đường, kiểm khớp) → `DjReply`. Bộ luật combo cũ (`planCombo`) chỉ là dự phòng khi AI không dùng được và không bao giờ cho bước xoá.

**Tech Stack:** NestJS 11 + Socket.IO + Prisma 7, youtubei.js (InnerTube, `yt.music.search`), Next.js 16 + React 19 + Tailwind 4, contracts dùng chung (`npm run contracts:sync` ở client).

**Spec:** `docs/specs/2026-10-18-dj-translator-design.md` (nối tiếp `docs/specs/2026-10-18-dj-chat-design.md`)

## Global Constraints

- Không test tự động (quy ước dự án). "Kiểm" trong từng task = script tạm trong scratchpad (ngoài repo) + `npm run lint && npm run typecheck`; client thêm `npm run build` khi không có `next dev` chạy song song. Server định dạng bằng `npx eslint --fix <file>`.
- Không commit / push / mở PR khi người dùng chưa nói "commit, push, mở PR và merge". Nhánh `feat/dj-translator` từ `origin/develop` ở cả hai repo.
- DB dev `localhost:55432/musicroom`; không đụng Neon / prod. Không `npm run build` server khi `nest start --watch` chạy.
- Trước khi bump `CONTRACTS_VERSION`: `git fetch origin && git show origin/develop:src/contracts/version.ts`; bump lên số kế tiếp (hiện `2026-10-18.4` → `2026-10-18.5` nếu chưa ai bump).
- Tối đa **1 lần gọi AI / yêu cầu** (kể cả `mood` picks và câu đáp `chat`); luật nhanh 0 lần. Lượt `DJ_AI_PER_HOUR` (10) / thành viên / giờ; AI không trả lời thì trả lượt (`limiter.undo`).
- Thất bại theo spec: thêm sai bài, xoá nhầm bài, không tìm được bài có thật. Xoá có `keep` theo ca sĩ: bài "không chắc" luôn **giữ**. Không bao giờ thêm bài không khớp ca sĩ / tên đã nêu.
- Mọi hành động qua service của web với actor là người hỏi (`QueueService`, `PlaybackService`, `LibraryService`, `PlaylistsService`).
- Playlist: chỉ của người hỏi, cần tài khoản (`actor.userId ?? member.userId`); không xoá / đổi tên / chia sẻ playlist.
- Chữ AI viết chỉ được hiện ở `chat` (`chatReply`): ≤ 200 ký tự, qua `blockedWords` (bị lọc → câu mẫu).
- Chữ hiện cho người dùng có ở cả `vi.ts` và `en.ts`; `content` lưu DB và Slack là tiếng Việt (`dj-text.ts`).
- Biểu tượng chỉ lucide; tương phản WCAG AA trên 13 chủ đề.
- Dev: server `npm run start:dev` (3001), client `NEXT_PUBLIC_SERVER_URL=http://localhost:3001 npm run dev` (3000).
- Bộ câu kiểm: bảng 29 câu trong spec ("Kiểm thử"), người hỏi "Khanh Nguyen", thành viên Khanh Nguyen / Lan / Minh Anh / Tuấn.

## Review Focus

1. Xoá có `keep.artist` khi bài trong hàng chờ chưa có `artist` (worker metadata chưa chạy) và kênh là kênh tổng hợp → phải **giữ** và báo "không chắc". → Task 4 kiểm `selectTargets`.
2. Tên thành viên trùng tên ca sĩ ("của Đen" khi có thành viên tên "Đen") → hiểu là người chọn. → Task 2 kiểm hướng dẫn với thành viên "Đen".
3. AI trả JSON sai khung / mã lạ / `count: 99` / `positions: [0]` → bỏ bước hoặc cắt, không ném lỗi, không xoá. → Task 2 kiểm `parseTranslation`.
4. Tìm bài có tên + ca sĩ mà YouTube Music trả bản cover / karaoke / "lyrics" của kênh khác đứng đầu → chọn bản của ca sĩ, không thêm cover. → Task 5 kiểm `DjFinder`.
5. "phát playlist X" khi người hỏi gần hết giới hạn hàng chờ → thêm được bao nhiêu thêm bấy nhiêu, báo N / M và lý do. → Task 6.
6. Câu đáp `chat` của AI có từ cấm hoặc dài → câu mẫu, không lặp câu mẫu vừa dùng trong phòng. → Task 7.

---

### Task 1: Contracts (server → client)

**Files:**
- Modify: `src/contracts/dj.ts`, `src/contracts/version.ts`
- Client: `npm run contracts:sync` (ghi `music-room-client/src/contracts/`)

**Interfaces:**
- Produces:
  - `DJ_ACTIONS` thêm `'suggest' | 'save' | 'playlistSave' | 'playlistCreate' | 'playlistPlay'`.
  - `DjStepReason` thêm `'kept'` (bài được giữ lại; `tracks` = các bài, `unsure` = số bài giữ vì không chắc), `'needSignIn'`, `'noPlaylist'`.
  - `DjStep` thêm: `tracks?: TrackSummary[]` (suggest: gợi ý; remove `kept`: bài giữ), `unsure?: number`, `artist?: string` (tên ca sĩ chuẩn đã hiểu), `playlist?: { id: string; name: string; created: boolean }`, `added?: number`, `total?: number` (playlistPlay / playlistCreate).
  - `DjReplyKind` thêm `'chat' | 'clarify'`; `DjReply` thêm `chatReply?: string`, `clarify?: { about: DjClarify; options?: string[] }`.
  - `export const DJ_CLARIFY = ['removeScope', 'whichSong', 'whichPlaylist'] as const; export type DjClarify = …`.

- [ ] **Step 1:** Fetch `origin/develop`, kiểm `version.ts` mới nhất.
- [ ] **Step 2:** Thêm các kiểu trên vào `src/contracts/dj.ts` (giữ trường cũ; tin DJ cũ trong lịch sử vẫn đọc được).
- [ ] **Step 3:** Bump `CONTRACTS_VERSION`.
- [ ] **Step 4:** Kiểm: server `npm run typecheck` báo lỗi `switch` thiếu nhánh ở `dj-text.ts` (mong đợi — Task 8 sửa); client `npm run contracts:sync` rồi `npm run typecheck` (lỗi ở `DjMessage.tsx` — Task 9 sửa).

### Task 2: Hướng dẫn dịch + kiểm khung (`dj-translate.ts`, thuần)

**Files:**
- Create: `src/dj/dj-translate.ts`
- Modify: `src/dj/dj-plan.ts` (chỉ kiểu: `PlanStep`, `Target`, thêm `Find`)

**Interfaces:**
- Consumes: `DjClarify`, `GUIDE_TARGETS` (Task 1).
- Produces:
  - `export interface Find { titles?: string[]; artist?: string; mode?: 'top'|'latest'|'popular'|'similar_now'|'mood'; mood?: string; picks?: { artist: string; song: string }[]; exclude?: { titles?: string[]; artist?: string } }`
  - `Target` thêm `artist?: string; keep?: { artist?: string; titles?: string[]; member?: string }` (giữ `all/mine/others/by/titles/except/positions/first/last/said` cũ; `scope:'member'` → `by`).
  - `PlanStep` thêm: `{ do: 'find'; find: Find; count: number; suggest?: boolean; pin?: Pin; asked?: number }`, `{ do: 'replaceWith'; target: Target; find: Find }`, `{ do: 'save' }`, `{ do: 'playlistSave'; playlist: string }`, `{ do: 'playlistCreate'; name: string; find?: Find; count?: number }`, `{ do: 'playlistPlay'; playlist: string }`.
  - `export const TRANSLATE_SYSTEM: string` — câu chữ theo spec "Khung hành động" + "Quy ước dạy AI" + quy tắc câu đáp `chat` (spec "Câu không liên quan"); ≤ ~700 token.
  - `export function translateInput(asker: string, members: string[], text: string): string` (JSON `{asker, members, text}`).
  - `export type Translation = { kind: 'plan'; plan: Plan } | { kind: 'info'; info: InfoKind } | { kind: 'guide'; guide: GuideTarget } | { kind: 'clarify'; about: DjClarify } | { kind: 'chat'; reply: string | null }`
  - `export function parseTranslation(raw: unknown): Translation` — không ném lỗi.

Luật `parseTranslation` (cái tên / câu test không tự quyết):
- `steps` không phải mảng / rỗng / mọi bước sai khung → `{kind:'chat', reply:null}`.
- Một bước duy nhất `info` / `guide` / `clarify` / `chat` → Translation tương ứng (`about` của `info` ánh xạ: `now→nowPlaying`, `who_picked→whoPicked`, `when_mine|next→myNext`, `queue→queueLength`, `mine→myCount`). `info` / `guide` lẫn trong nhiều bước → bỏ.
- `remove` không có `scope` hợp lệ, không `titles`, không vị trí → cả Translation thành `clarify removeScope`.
- `count` cắt 1..`MAX_SONGS` (5), số xin lớn hơn ghi vào `asked`; `positions` bỏ 0 và |n| > 50; chuỗi cắt 150 ký tự, mảng tối đa 10.
- `wish` của bước `add` đầu tiên → `plan.wish` (≤ `LIMITS` lời chúc hiện có).
- `picks` chỉ giữ khi `mode = 'mood'`, tối đa 5.
- `reply` của `chat`: trim, cắt 200 ký tự; rỗng → `null`.

- [ ] **Step 1:** Viết kiểu + `TRANSLATE_SYSTEM` + `translateInput` + `parseTranslation`.
- [ ] **Step 2:** Kiểm (script scratchpad, gọi Gemini với `TRANSLATE_SYSTEM`, giãn 4,5 s / câu): 29 câu của spec + câu "xoá bài của Đen" với thành viên thêm "Đen". Mong đợi: 4 câu người dùng đúng 100%; ≥ 26/29 khớp cột "Ý đúng"; "Đen" → `by`.
- [ ] **Step 3:** Kiểm `parseTranslation` bằng script với đầu vào xấu: `null`, `{steps:"x"}`, `{steps:[{do:"remove"}]}` → `clarify removeScope`; `{steps:[{do:"add",find:{artist:"a"},count:99}]}` → `count 5, asked 99`; `positions:[0,-1,99]` → `[-1]`.
- [ ] **Step 4:** `npm run lint && npm run typecheck` (chỉ còn lỗi đã biết ở Task 1).

### Task 3: Luật nhanh (`matchQuick`)

**Files:**
- Modify: `src/dj/dj-rules.ts`

**Interfaces:**
- Produces: `export type QuickMatch = { kind: 'hello' } | { kind: 'info'; info: InfoKind } | { kind: 'guide'; guide: GuideTarget } | { kind: 'plan'; plan: Plan }` và `export function matchQuick(request: string): QuickMatch | null`.

Nhận khi **toàn bộ** câu (bỏ lời đệm `FILLER_START` / `FILLER_END`) khớp một mẫu:
- `plan`: skip / bỏ qua / qua bài / next (+ "N bài") → `{do:'skip', count}`; tạm dừng / dừng nhạc / pause → `pause`; phát tiếp / resume / tiếp tục → `resume`; lưu bài này / save → `save`. (Tim chỉ áp dụng bài trong hàng chờ, nên câu thả tim luôn đi AI để biết bài nào.)
- `info`: các mẫu `INFOS` hiện có.
- `guide`: các mẫu `GUIDES` câu hỏi cách dùng (lời bài hát, nghe cùng, chia sẻ / QR, thu nhỏ, chặn) — chỉ khi câu là **câu hỏi** ("làm sao", "ở đâu", "cách", "how", dấu "?") hoặc chỉ gồm tên chức năng.
- `hello`: như cũ.
Còn sót từ ngoài mẫu → `null`. `matchRules` cũ giữ nguyên cho dự phòng (Task 7).

- [ ] **Step 1:** Viết `matchQuick`.
- [ ] **Step 2:** Kiểm script: "skip giúp tôi" → skip 1; "bỏ qua 2 bài" → skip 2; "tạm dừng đi" → pause; "lưu bài này" → save; "bài đang phát tên gì vậy" → info; "làm sao để chặn một bài" → guide block; "bỏ qua 2 bài rồi tạm dừng", "skip đến bài cuối giúp tôi", "thêm nhạc của jack j97", "xoá bớt đi" → `null`.
- [ ] **Step 3:** lint + typecheck.

### Task 4: Ca sĩ chuẩn + lọc hàng chờ (`DjResolver`)

**Files:**
- Modify: `src/music/innertube.provider.ts`
- Create: `src/dj/dj-resolve.ts` (hàm thuần + `@Injectable() DjResolver`), đăng ký trong module chứa `DjComboService`.

**Interfaces:**
- Produces (InnerTube): `musicArtist(name: string): Promise<{ name: string } | null>` (`yt.music.search(name, {type:'artist'})`, kết quả đầu có tên khớp sau chuẩn hoá — chứa nhau hoặc chung từ ≥ 3 ký tự); `musicSongs(query: string, max: number): Promise<{ externalId: string; title: string; artist: string; durationSec: number | null }[]>` (`type:'song'`). Cả hai đi qua bộ đếm lỗi / nghỉ sẵn có của provider.
- Produces (resolve):
  - `export interface Artist { name: string; aliases: string[]; verified: boolean }` — `aliases` = tên chuẩn + tên người gõ + các phần tách bởi ` - `, `&`, `ft.`, `feat`, ` x `, `,` (chuẩn hoá `normalizeQuery`, bỏ phần < 2 ký tự).
  - `DjResolver.artist(said: string): Promise<Artist>` — bộ nhớ đệm `Map` theo `normalizeQuery(said)`, 24 giờ, tối đa 500 mục; InnerTube lỗi → `{name: said, aliases, verified:false}`.
  - `export function artistMatch(track: TrackSummary, a: Artist): 'yes' | 'no' | 'unsure'` — `yes`: `track.artist` hoặc `channel` hoặc `title` chứa một alias (theo từ, đã chuẩn hoá); `no`: `track.artist` có và không khớp, hoặc `artist` null nhưng kênh và tiêu đề đều không khớp **và** `a.verified`; còn lại `unsure`.
  - `export function selectTargets(queue: QueueItemView[], t: Target, me: Member, artists: { artist?: Artist; keep?: Artist }): { items: QueueItemView[]; kept: QueueItemView[]; unsure: number }` — thứ tự: `mine/others/by` → `artist` (chỉ `yes`) → `titles` → loại `keep` (artist `yes` **hoặc** `unsure` → giữ; `titles`; `member`) và `except` cũ → vị trí. `kept` = bài khớp phạm vi nhưng bị giữ.

- [ ] **Step 1:** InnerTube `musicArtist`, `musicSongs`.
- [ ] **Step 2:** `dj-resolve.ts`.
- [ ] **Step 3:** Kiểm script: `musicArtist('j97')` → "Jack - J97"; `artistMatch` với bài `{artist:'Jack', channel:'Jack - J97 Official'}` → yes; `{artist:null, channel:'Nhạc Trẻ Hay', title:'Thiên Lý Ơi'}` với J97 → unsure; `selectTargets` hàng chờ giả 5 bài (2 của J97, 1 unsure, 2 khác, đều của "me") với `{mine, keep:{artist:'j97'}}` → xoá 2, kept 3, unsure 1.
- [ ] **Step 4:** lint + typecheck.

### Task 5: Tìm bài (`DjFinder`)

**Files:**
- Create: `src/dj/dj-find.ts` (`@Injectable() DjFinder`)

**Interfaces:**
- Consumes: `DjResolver`, `InnerTubeProvider.musicSongs`, `findFresh`, `DjService.findKnown`, `SearchService.search`, `InnerTubeProvider.upNext`, `SnapshotService`.
- Produces: `DjFinder.candidates(me: Member, roomId: string, find: Find): AsyncGenerator<{ externalId: string; title: string; artist: string | null }>` — ứng viên **đã khớp**, theo thứ tự ưu tiên, không trùng; và `DjFinder.artistOf(find: Find): Promise<Artist | undefined>` để câu trả lời ghi tên chuẩn.

Thứ tự theo spec "Tìm bài":
- `titles` (mỗi tên một lượt): thư viện (`findKnown` khi có ca sĩ) → `musicSongs("tên ca sĩ")` lấy bài có tiêu đề chứa tên **và** (không nêu ca sĩ hoặc `artistMatch` = yes) → `search.search` video lọc tên + ca sĩ, loại tiêu đề có `cover|karaoke|reaction|remix|beat|instrumental|lyrics?` trừ khi người hỏi gõ chữ đó.
- `artist` không tên bài: `mode` `latest|popular` → `findFresh`; `top` (mặc định) → `musicSongs(tên chuẩn)` lọc `artistMatch` yes.
- `similar_now`: `upNext(bài đang phát)` → các id.
- `mood`: từng `picks` → `musicSongs("artist song")` cần cả tên bài và ca sĩ khớp; hết → `musicSongs(mood)` (bỏ kết quả > 10 phút).
- `exclude`: bỏ ứng viên có tiêu đề khớp `exclude.titles` hoặc `artistMatch(exclude.artist)` = yes.
- InnerTube nghỉ → chỉ còn `findKnown` + `search.search` (Data API).

- [ ] **Step 1:** Viết `DjFinder`.
- [ ] **Step 2:** Kiểm script (Nest app context trên dev): `{artist:'j97'}` → 3 ứng viên đầu đều của Jack - J97; `{titles:['Lạc Trôi'], artist:'Sơn Tùng'}` → bài đầu là Lạc Trôi của Sơn Tùng M-TP (không cover); `{artist:'Đen', exclude:{titles:['Bài này chill phết']}}` → không có bài đó; `{mode:'mood', mood:'chill', picks:[{artist:'Vũ.',song:'Lạ Lùng'},{artist:'Ai Đó',song:'Bài Không Có Thật'}]}` → Lạ Lùng, bỏ bài bịa.
- [ ] **Step 3:** lint + typecheck.

### Task 6: Thực hiện bước mới (`DjComboService`)

**Files:**
- Modify: `src/dj/dj-combo.service.ts`

**Interfaces:**
- Consumes: Task 2 (`PlanStep` mới), Task 4 (`selectTargets`, `DjResolver`), Task 5 (`DjFinder`), `LibraryService.setFavorite`, `PlaylistsService.mine/create/setTrack/get`, `QueueService.addMany`.
- Produces: `run(plan, me, actor, aiPicks)` giữ chữ ký; xử lý thêm:
  - `find` (`suggest: false`): `addSongs(run, ids từ DjFinder.candidates, count, {pin, query, exact: Boolean(find.titles)})`; bước ok mang `artist` chuẩn.
  - `find` (`suggest: true`): lấy tối đa `count` (mặc định 3) ứng viên, `tracks` bằng `LibraryService`/`tracks:lookup` hiện có (TrackSummary), push `{action:'suggest', ok: tracks.length>0, tracks, artist}`; rỗng → `reason:'notFound'`.
  - `heart/remove/pin` với `Target` mới: dùng `selectTargets` (resolve `artist` / `keep.artist` trước). `remove`: xoá `items` như cũ, rồi nếu `kept.length` push `{action:'remove', ok:true, reason:'kept', tracks: kept.track, unsure, artist}`; `items` rỗng mà `kept` có → chỉ dòng `kept`.
  - `replaceWith`: bài đầu của `selectTargets(target)` trong bài của người hỏi (quản trị viên: mọi bài) → xoá → `find` thêm 1 bài.
  - `save`: bài đang phát → `library.setFavorite(actor, trackId, true)`; không có bài → `nothingPlaying`.
  - `playlistSave` / `playlistCreate` / `playlistPlay`: `userId = actor.userId ?? me.userId`; không có → `reason:'needSignIn'`. Tìm playlist theo tên: khớp `normalizeQuery` bằng nhau trước, rồi chứa nhau; nhiều khớp ngang → `reason:'noPlaylist'` kèm `query` (brain đổi thành `clarify whichPlaylist` với `options` = tên). `playlistSave`: không có → `create(userId, name, [trackId])` (`created:true`); có → `setTrack(…, true)`. `playlistCreate`: trùng tên → dùng playlist đó; `find` → tối đa `count` ứng viên → `create(userId, name, trackIds)`; `added` = số bài. `playlistPlay`: `get` → trackIds theo thứ tự → `queue.addMany(actor, ids.slice(0, ADD_MANY_MAX))` → `{added, total, …}`; lỗi giới hạn → `errorCode`.
  - `planCombo` cũ (`addArtist/addVague/addPicks/add/replace`) vẫn chạy như trước.

- [ ] **Step 1:** Viết các nhánh trên (tách hàm riêng mỗi loại như code hiện có).
- [ ] **Step 2:** Kiểm trên dev (script socket vào phòng dev, người hỏi là chủ phòng có tài khoản dev `devtestuser0001`): hàng chờ dựng sẵn 5 bài (2 của J97) → plan `remove {mine, keep:{artist:'j97'}}` → còn đúng 2 bài J97, câu trả lời có dòng `kept`; `playlistSave 'Chill DJ test'` lần 1 `created:true`, lần 2 `created:false`; `playlistPlay` playlist 3 bài → `added 3`; khách (không tài khoản) → `needSignIn`.
- [ ] **Step 3:** lint + typecheck.

### Task 7: Bộ não mới (`DjBrainService`) + câu đáp `chat`

**Files:**
- Modify: `src/dj/dj-brain.service.ts`
- Create: `src/dj/dj-chat-lines.ts` (kho câu mẫu)

**Interfaces:**
- Consumes: `matchQuick` (Task 3), `TRANSLATE_SYSTEM` / `translateInput` / `parseTranslation` (Task 2), `DjComboService.run` (Task 6), `blockedWords` (`src/ai/moderation.ts`).
- Produces: luồng `answer()`:
  1. `matchQuick` → `hello` / `info` / `guide` / `plan` (plan → `combo`).
  2. AI bật và còn lượt → một lần `ai.json('dj', TRANSLATE_SYSTEM, translateInput(me.displayName, tên thành viên đang hoạt động không phải thiết bị, request))` → `parseTranslation`:
     - `plan` → `combo` (bỏ `guideOfAiPlan`: việc đơn làm luôn); `info` / `guide` như cũ; `clarify` → `{kind:'clarify', clarify:{about}}`; `chat` → `chatReply(reply, roomId)`.
     - Bước `noPlaylist` trong kết quả combo → trả `clarify whichPlaylist` với `options` = tên playlist của người hỏi (tối đa 8).
  3. AI tắt / hết lượt / không trả lời: `planCombo(request)` **bỏ mọi bước `remove`/`replace`**; còn bước → `combo`; không → `matchRules` cũ chỉ cho `info` / `guide`; còn lại → `{kind:'other'}` (câu "chưa hiểu" + ví dụ) hoặc `busy` khi hết lượt.
  - `export const CHAT_LINES: { vi: string[]; en: string[] }` (~30 câu vi, ~30 en; giọng DJ văn phòng, lái về âm nhạc).
  - `chatReply(reply: string | null, roomId: string): DjReply` — `reply` hợp lệ (≤ 200, `blockedWords(reply).length === 0`) → dùng; không → câu mẫu ngẫu nhiên khác câu mẫu vừa dùng trong phòng (`Map<roomId, index>`). Ngôn ngữ câu mẫu: theo ngôn ngữ phòng/người hỏi hiện có (mặc định vi).
  - Bỏ `callAi` cũ (prompt `SYSTEM`, `known`, `queue`), `aiPicks` trả `null` (không còn lần gọi thứ hai).

- [ ] **Step 1:** Viết luồng mới + `dj-chat-lines.ts`.
- [ ] **Step 2:** Kiểm trên dev qua chat phòng dev (script socket gửi `chat:send` "@DJ …"): 29 câu của spec → ghi lại `DjReply` từng câu vào scratchpad; mong đợi như cột "Ý đúng", không câu nào xoá bài ngoài phạm vi. Câu 22 "nay mệt quá" → `chat` có `chatReply`. Đặt `GEMINI_API_KEY`/`GROQ_API_KEY` rỗng tạm (biến môi trường lúc chạy, không sửa `.env`) → "skip giúp tôi" vẫn chạy; "xoá hết bài của tôi trừ j97" → `other`, không xoá.
- [ ] **Step 3:** lint + typecheck.

### Task 8: Câu tiếng Việt cho lịch sử / Slack (`dj-text.ts`, Slack)

**Files:**
- Modify: `src/dj/dj-text.ts`, `src/chat/slack/slack-blocks.ts` (nếu cần nhánh mới)

**Interfaces:**
- Produces: `stepText` / `djText` có nhánh cho `suggest`, `save`, `playlistSave/Create/Play`, reason `kept` / `needSignIn` / `noPlaylist`, kind `chat` (nguyên `chatReply`) và `clarify` (câu hỏi lại theo `about`, kèm `options`). Câu luôn ghi tên ca sĩ chuẩn khi có `artist`.
  - Mẫu chính (vi): suggest "Gợi ý bài của {artist}: 1. …"; kept "Đã giữ lại {n} bài{ của artist}{, trong đó {unsure} bài chưa chắc ca sĩ}"; needSignIn "Cần đăng nhập Google để dùng playlist"; playlistSave "Đã lưu "{bài}" vào playlist {tên}{ (playlist mới)}"; playlistPlay "Đã thêm {added}/{total} bài của playlist {tên}"; clarify removeScope "Bạn muốn xoá bài nào? Ví dụ: "xoá bài cuối của tôi", "xoá bài của Lan""; whichPlaylist "Playlist nào? {options}".
- Slack: `chat`, `clarify` trả lời riêng; `done` công khai như hiện tại.

- [ ] **Step 1:** Viết nhánh mới.
- [ ] **Step 2:** lint + typecheck server **sạch**.

### Task 9: Client — hiển thị và i18n

**Files:**
- Modify: `music-room-client/src/components/room/DjMessage.tsx`, `src/i18n/vi.ts`, `src/i18n/en.ts`

**Interfaces:**
- Consumes: contracts Task 1 (đã sync).
- Produces:
  - `stepLine` / `djReplyText` có nhánh mới (cùng ý như Task 8, theo ngôn ngữ người xem; "bạn" cho người hỏi).
  - Bước `suggest`: danh sách thẻ bài (`Thumb` 48, tên, kênh) mỗi thẻ nút **"Thêm"** (lucide `Plus`) cho **mọi người**: `act('queue:add', { input: 'https://www.youtube.com/watch?v=' + externalId })`; đã có trong hàng chờ / đang phát → nút thành "Đã có" (disabled).
  - Bước `remove` reason `kept`: dòng "đã giữ lại" + danh sách tên bài thu gọn (tối đa 5, "+N").
  - Kind `chat`: bong bóng DJ với `chatReply` (không qua i18n). Kind `clarify`: câu hỏi lại + `options` dạng chip chỉ đọc.
  - i18n `djBot.steps` thêm khoá: `suggested`, `kept`, `keptUnsure`, `saved`, `playlistSaved`, `playlistCreated`, `playlistPlayed`, `needSignIn`, `noPlaylist`, `add` button `addOne`, `alreadyIn`; `djBot.clarify.{removeScope, whichSong, whichPlaylist}`; `verbs` thêm 5 hành động mới.

- [ ] **Step 1:** Viết.
- [ ] **Step 2:** `npm run lint && npm run typecheck && npm run build` (client, không chạy `next dev` song song).
- [ ] **Step 3:** Kiểm trên trình duyệt dev (Playwright): phòng dev, gửi câu 2, 3, 22, 25 → tin DJ hiện đúng; nút "Thêm" trên gợi ý thêm được bài; chụp màn hình chủ đề sáng (hifi82) và tối, điện thoại 375 px — chữ đạt AA.

### Task 10: Kiểm tổng trên dev + ghi chú

- [ ] **Step 1:** Chạy lại 29 câu end-to-end (Task 7 Step 2) sau Task 8–9; bảng kết quả (câu → hiểu thành → đã làm) lưu scratchpad để đưa vào mô tả PR.
- [ ] **Step 2:** Cập nhật spec mục "Quyết định khi triển khai" nếu có lệch (ghi rõ).
- [ ] **Step 3:** Báo người dùng kết quả + chờ lệnh "commit, push, mở PR và merge".
