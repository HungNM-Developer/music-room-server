import { AppError } from '../common/app-error';
import type { ErrorCode, ErrorParams } from '../contracts';

// Đợt 3: Vietnamese text for chat apps (same wording as the web client's messages).

const mmss = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

const ERRORS: Partial<Record<ErrorCode, (p: ErrorParams) => string>> = {
  FORBIDDEN: () =>
    'Bạn không có quyền làm việc này (có thể đã bị mời ra khỏi phòng).',
  ROOM_NOT_FOUND: () => 'Không tìm thấy phòng. Hãy kiểm tra lại mã phòng.',
  NAME_TAKEN: () =>
    'Không đặt được tên cho bạn trong phòng. Hãy đổi tên hiển thị Slack rồi thử lại.',
  PIN_INVALID: (p) => `Mã PIN không đúng. Bạn còn ${p.remaining} lần thử.`,
  PIN_LOCKED: (p) =>
    `Nhập sai mã PIN quá nhiều lần. Hãy thử lại sau ${p.minutes} phút.`,
  PIN_NOT_SET: () =>
    'Phòng này chưa đặt mã PIN quản trị. Hãy đặt mã trong Cài đặt phòng trên web.',
  ALREADY_QUEUED: () => 'Bài này đã có trong hàng chờ hoặc đang phát.',
  OWN_SONG: () => 'Không thả tim được bài của chính mình.',
  PLAYED_RECENTLY: (p) =>
    `Bài này vừa phát ${p.minutes} phút trước. Phòng chỉ cho thêm lại sau ${p.gap} phút.`,
  QUEUE_LIMIT: (p) =>
    `Bạn đã có ${p.max} bài đang chờ. Hãy đợi bài của bạn phát rồi thêm tiếp.`,
  TRACK_TOO_LONG: (p) =>
    `Bài này dài ${mmss(Number(p.duration))}, vượt giới hạn ${mmss(Number(p.max))} của phòng. Hãy chọn bài ngắn hơn.`,
  TRACK_NOT_EMBEDDABLE: () =>
    'Video này không cho phát ngoài YouTube. Hãy chọn bản khác.',
  TRACK_NOT_FOUND: () =>
    'Không tìm thấy video. Có thể video đã bị xóa hoặc để riêng tư.',
  TRACK_BLOCKED: () => 'Bài này đã bị quản trị viên chặn trong phòng.',
  TRACK_LIVE: () =>
    'Không thể thêm video đang phát trực tiếp. Hãy chọn video thường.',
  LINK_UNSUPPORTED: () =>
    'Không nhận ra link YouTube này. Hãy dán link dạng youtube.com/watch?v=… hoặc youtu.be/…',
  SEARCH_UNAVAILABLE: () =>
    'Máy chủ chưa bật tìm kiếm. Hãy dán link YouTube để thêm bài.',
  QUOTA_EXCEEDED: () =>
    'Hôm nay đã hết lượt tìm kiếm. Hãy dán link YouTube để thêm bài.',
  RATE_LIMITED: (p) =>
    `Bạn thao tác hơi nhanh. Hãy thử lại sau ${p.seconds} giây.`,
  STALE_ITEM: () => 'Bài này đã kết thúc hoặc vừa đổi bài.',
  SKIP_BLOCKED: (p) =>
    `Cả phòng vừa chọn nghe tiếp bài này. Thử lại sau ${p.seconds} giây.`,
  VOTE_CLOSED: () => 'Cuộc bỏ phiếu đã kết thúc.',
  MESSAGE_BLOCKED: () => 'Nội dung có từ ngữ không phù hợp.',
};

export function chatError(e: unknown): string {
  if (e instanceof AppError) {
    const f = ERRORS[e.code];
    return f ? f(e.params ?? {}) : `Không làm được (${e.code}).`;
  }
  return 'Máy chủ đang gặp sự cố. Hãy thử lại sau ít phút.';
}

export const CHAT = {
  notLinked:
    'Kênh này chưa nối với phòng nào. Quản trị viên gõ `/music connect <MÃ PHÒNG> <PIN>` để nối.',
  connected: (name: string, code: string) =>
    `🎶 Đã nối kênh này với phòng *${name}* (${code}). Gõ \`/music\` để xem bài đang phát, \`/music help\` để xem các lệnh.`,
  hereThread:
    '🎶 Từ giờ thẻ bỏ phiếu qua bài của phòng được đăng vào thread này. Gõ `/music here` ở kênh để đưa về kênh chính.',
  hereChannel: '🎶 Từ giờ thẻ bỏ phiếu qua bài được đăng ở kênh chính.',
  pinInMention:
    '⚠️ Đừng gõ mã PIN khi tag bot: tin nhắn tag ai trong kênh cũng đọc được. Hãy dùng `/music connect <MÃ PHÒNG> <PIN>` (chỉ bạn thấy). Nếu vừa gõ PIN ở đây, hãy xoá tin nhắn đó và đổi PIN trong Cài đặt phòng trên web.',
  disconnected: 'Đã bỏ nối kênh này với phòng.',
  connectUsage: 'Cách dùng: `/music connect <MÃ PHÒNG> <PIN quản trị>`',
  disconnectUsage: 'Cách dùng: `/music disconnect <PIN quản trị>`',
  addUsage: 'Cách dùng: `/music add <tên bài hoặc link YouTube>`',
  help: [
    '*Music Room trên Slack* — gõ `/music …` ở kênh, hoặc tag `@Music Room …` (dùng được cả trong thread)',
    '• `/music` — bài đang phát (có nút ❤️ 🔥 ⏭ 🎧)',
    '• `/music add <tên bài hoặc link YouTube>` — thêm bài vào hàng chờ',
    '• `/music skip` — bỏ phiếu qua bài',
    '• `/music queue` — 5 bài tiếp theo',
    '• `@Music Room <câu bất kỳ>` hoặc `/music <câu bất kỳ>` — hỏi DJ: "bài mới của Đen Vâu", "vài bài chill", "còn bao lâu tới bài của tôi". Câu bạn gửi DJ được chuyển cho AI miễn phí.',
    '• Lệnh chỉ chạy khi gõ ngắn đúng dạng: `skip`, `now`, `queue`, `help`, `here`, `add <tên bài ngắn | link>`; câu dài hơn sẽ do DJ hiểu.',
    '• Trang *Home* của bot (mục Apps → Music Room): xem bài đang phát, ➕ Thêm bài, 🎧 Hỏi DJ, bỏ phiếu ngay tại đó',
    '• `@Music Room here` trong một thread — thẻ bỏ phiếu đăng vào thread đó; `/music here` ở kênh — đưa về kênh',
    '• `/music connect <MÃ PHÒNG> <PIN>` / `/music disconnect <PIN>` — quản trị viên nối / bỏ nối kênh (chỉ dùng `/music`, không tag bot kèm PIN)',
  ].join('\n'),
  searching: (q: string) => `🔎 Đang tìm "${q}"…`,
  askingDj: 'Đang hỏi DJ…',
  noResults: (q: string) =>
    `Không tìm thấy bài nào cho "${q}". Thử tên khác hoặc dán link YouTube.`,
  added: (title: string) => `✅ Đã thêm *${title}* vào hàng chờ.`,
  voted: (approve: boolean) =>
    approve ? '✅ Bạn đã bỏ phiếu qua bài.' : '❌ Bạn đã chọn nghe tiếp.',
  idle: 'Loa đang chờ bài. Gõ `/music add <tên bài>` để thêm.',
  queueEmpty: 'Hàng chờ đang trống.',
  queueTitle: '*Tiếp theo*',
  mmss,
};
