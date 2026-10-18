import { chatError } from '../chat/chat-text';
import { AppError } from '../common/app-error';
import type { DjAction, DjReply, DjStep, GuideTarget } from '../contracts';

/**
 * The DJ's answer as plain Vietnamese: the chat history's `content`, the speaker screen and
 * Slack. Room clients word `DjReply` themselves, in the viewer's language.
 */

const GUIDE: Record<GuideTarget, string> = {
  skip: 'Việc này bạn tự bấm được: nút Bỏ qua mở bỏ phiếu cho cả phòng (người có quyền điều khiển thì có nút Chuyển bài qua ngay).',
  save: 'Bấm nút Lưu cạnh bài đang phát để giữ bài vào danh sách của bạn.',
  heart: 'Thả tim cho bài trong hàng chờ để bài đó được phát sớm hơn.',
  pause:
    'Nút Tạm dừng / Phát tiếp nằm cạnh bài đang phát (chỉ người có quyền điều khiển).',
  lyrics: 'Bấm "Lời bài hát" dưới tên bài đang phát để xem lời.',
  listen: 'Bấm "Nghe cùng" để nghe ngay trên máy bạn, khớp với cả phòng.',
  share: 'Bấm nút Chia sẻ ở đầu trang để lấy link hoặc mã QR mời mọi người.',
  mini: 'Bấm nút Thu nhỏ để giữ bài đang phát trong một khung nhỏ.',
  add: 'Gõ tên bài vào ô Thêm bài là thêm được ngay.',
  myItem: 'Bài của bạn nằm trong hàng chờ.',
  block: 'Quản trị viên chặn bài bằng nút Tùy chọn cạnh bài.',
};

function minutes(sec: number): number {
  return Math.max(1, Math.round(sec / 60));
}

function when(etaSec: number | null | undefined): string {
  if (etaSec === null || etaSec === undefined) return '';
  return etaSec < 45
    ? ', sắp phát ngay'
    : `, khoảng ${minutes(etaSec)} phút nữa`;
}

function infoText(r: DjReply): string {
  const i = r.info;
  if (!i) return 'Mình chưa xem được thông tin phòng.';
  switch (i.kind) {
    case 'nowPlaying':
      return i.title ? `Đang phát: ${i.title}.` : 'Phòng chưa phát bài nào.';
    case 'whoPicked':
      return i.title
        ? i.pickedBy
          ? `${i.pickedBy} chọn bài đang phát.`
          : 'Bài đang phát do phòng tự chọn.'
        : 'Phòng chưa phát bài nào.';
    case 'myNext':
      if (!i.queueItemId) return `${r.forName} chưa có bài nào đang chờ.`;
      return i.ahead === 0
        ? `Bài của ${r.forName} là bài kế tiếp${when(i.etaSec)}.`
        : `Còn ${i.ahead} bài nữa là tới bài của ${r.forName}${when(i.etaSec)}.`;
    case 'queueLength':
      return i.count
        ? `Hàng chờ còn ${i.count} bài${i.totalSec ? `, khoảng ${minutes(i.totalSec)} phút` : ''}.`
        : 'Hàng chờ đang trống.';
    case 'myCount':
      return `${r.forName} đang có ${i.count ?? 0} bài trong hàng chờ.`;
  }
}

const VERB: Record<DjAction, string> = {
  add: 'thêm bài',
  heart: 'thả tim',
  remove: 'gỡ bài',
  pin: 'ghim bài',
  skip: 'chuyển bài',
  vote: 'bỏ phiếu bỏ qua',
  pause: 'tạm dừng',
  resume: 'phát tiếp',
};

/** One line of a combo answer. */
export function stepText(s: DjStep): string {
  const song = s.track ? `"${s.track.title}"` : 'bài';
  if (s.ok)
    switch (s.action) {
      case 'add': {
        const wish = s.wish ? `, kèm lời chúc "${s.wish}"` : '';
        if (s.position === 0) return `Đã bật ${song}, đang phát ngay${wish}`;
        const at = s.position
          ? `, đứng thứ ${s.position}${when(s.etaSec)}`
          : '';
        return `Đã thêm ${song}${at}${wish}`;
      }
      case 'heart':
        if (s.reason === 'alreadyHearted')
          return `${song} đã được thả tim từ trước`;
        return s.reason === 'oneHeart'
          ? `Đã thả tim ${song} (mỗi người chỉ thả tim được 1 bài trong hàng chờ)`
          : `Đã thả tim ${song}`;
      case 'remove':
        return `Đã gỡ ${song}`;
      case 'pin':
        return s.now
          ? `Đã chuyển sang ${song} ngay`
          : `Đã ghim ${song} phát tiếp theo`;
      case 'skip':
        return `Đã bỏ qua ${song}`;
      case 'vote':
        return `Đã bỏ phiếu bỏ qua ${song}`;
      case 'pause':
        return 'Đã tạm dừng nhạc';
      case 'resume':
        return 'Đã phát tiếp nhạc';
    }
  switch (s.reason) {
    case 'notFound':
      if (s.got !== undefined) return `Chỉ thêm được ${s.got}/${s.wanted} bài`;
      return s.query
        ? `Không tìm thấy "${s.query}"`
        : 'Không tìm thấy bài phù hợp';
    case 'busy':
      return 'DJ đang bận, chưa chọn được bài';
    case 'nothingPlaying':
      return 'Phòng chưa phát bài nào';
    case 'notMine':
      return 'Chỉ gỡ được bài của chính mình';
    case 'ownSong':
      return `Không thả tim được ${song}: đó là bài của chính bạn`;
    case 'tooMany':
      return `Mỗi lần DJ thêm tối đa ${s.got} bài (bạn xin ${s.wanted} bài)`;
  }
  const why =
    s.errorCode === 'FORBIDDEN'
      ? s.action === 'remove'
        ? 'chỉ gỡ được bài của chính mình'
        : 'cần quyền điều khiển'
      : s.errorCode && s.errorCode !== 'INTERNAL'
        ? chatError(new AppError(s.errorCode, s.errorParams))
        : 'có lỗi, thử lại sau nhé';
  // Pause / resume are about the room, not a song.
  const what =
    s.action === 'pause' || s.action === 'resume'
      ? ''
      : s.track
        ? ` "${s.track.title}"`
        : s.query
          ? ` "${s.query}"`
          : '';
  const verb = s.action === 'pin' && s.now ? 'chuyển tới bài' : VERB[s.action];
  return `Không ${verb} được${what}: ${why}`;
}

export function djText(r: DjReply): string {
  switch (r.kind) {
    case 'hello':
      return 'Chào bạn, mình là DJ của phòng. Thử: "bật vài bài chill cho buổi chiều", "bài mới của Sơn Tùng", "còn bao lâu tới bài của tôi". Câu bạn gửi DJ được chuyển cho AI miễn phí.';
    case 'guide': {
      if (r.guide === 'add' && r.query)
        return `Bạn gõ "${r.query}" vào ô Thêm bài là thêm được ngay.`;
      return GUIDE[r.guide ?? 'add'];
    }
    case 'info':
      return infoText(r);
    case 'done':
      return [
        `Xong, mình đã làm cho ${r.forName}:`,
        ...(r.steps ?? []).map((s) => `- ${stepText(s)}`),
      ].join('\n');
    case 'added': {
      const what =
        r.fresh === 'latest'
          ? 'bài mới nhất mình tìm được'
          : r.fresh === 'popular'
            ? 'bài đang hot mình tìm được'
            : 'bài';
      const song = r.track?.title ? `${what} "${r.track.title}"` : what;
      if (r.position === 0)
        return `Đã bật ${song} cho ${r.forName}, đang phát ngay.`;
      const at = r.position ? `, đứng thứ ${r.position}${when(r.etaSec)}` : '';
      return `Đã thêm ${song} cho ${r.forName}${at}.`;
    }
    case 'denied':
      return r.errorCode && r.errorCode !== 'FORBIDDEN'
        ? chatError(new AppError(r.errorCode, r.errorParams))
        : 'Bạn chưa có quyền làm việc này.';
    case 'busy':
      return r.retryAfterSec
        ? `Bạn đã hỏi DJ nhiều quá, thử lại sau khoảng ${minutes(r.retryAfterSec)} phút nhé.`
        : 'Mình đang hơi quá tải, bạn thử lại sau ít phút nhé.';
    case 'error':
      if (r.errorCode === 'TRACK_NOT_FOUND')
        return 'Mình chưa tìm được bài hợp yêu cầu, bạn thử gõ tên bài vào ô Thêm bài nhé.';
      return r.errorCode && r.errorCode !== 'INTERNAL'
        ? chatError(new AppError(r.errorCode, r.errorParams))
        : 'Mình chưa làm được việc này, bạn thử lại sau nhé.';
    case 'other':
      return 'Mình chưa giúp được việc này. Thử: "bật vài bài chill", "bài mới của Đen Vâu", "còn bao lâu tới bài của tôi".';
  }
}
