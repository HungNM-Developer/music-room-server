import type { TrackSummary } from '../../contracts';
import type { HomeTrack, HomeView } from '../chat-room.service';
import { CHAT } from '../chat-text';
import { button, esc, thumb } from './slack-blocks';

// The bot's Home tab and its "Thêm bài" modal (Block Kit views). Action ids are read back in
// SlackHomeService; private_metadata carries the room (and the modal's search results).

export type View = Record<string, unknown>;

/** A room the person can switch the Home tab to. */
export interface HomeRoom {
  id: string;
  code: string;
  name: string;
}

const PROGRESS_CELLS = 18;
const PRESENT_NAMES = 6;
const VN_TIME = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Ho_Chi_Minh',
});

/** A time Slack shows in each reader's own timezone and clock format. */
const clock = (ms: number) =>
  `<!date^${Math.floor(ms / 1000)}^{time}|${VN_TIME.format(ms)}>`;

const text = (t: string) => ({ type: 'mrkdwn', text: t });
const section = (t: string, accessory?: unknown) => ({
  type: 'section',
  text: text(t),
  ...(accessory ? { accessory } : {}),
});
const context = (...elements: unknown[]) => ({ type: 'context', elements });
const divider = { type: 'divider' };
const plain = (t: string) => ({ type: 'plain_text', text: t, emoji: true });
const cut = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

function progress(pos: number, dur: number): string {
  const k = Math.round(Math.min(1, Math.max(0, pos / dur)) * PROGRESS_CELLS);
  return '▰'.repeat(k) + '▱'.repeat(PROGRESS_CELLS - k);
}

function picker(t: HomeTrack): string | null {
  if (t.pickedBy) return `${esc(t.pickedBy)} chọn`;
  if (t.auto === 'radio') return '📻 Radio của phòng chọn';
  if (t.auto === 'fallback') return '📀 Playlist dự phòng';
  return null;
}

/** "*Song*\nArtist" when the title was parsed, else the raw title. */
function songLines(t: HomeTrack): string {
  return t.song && t.artist
    ? `*${esc(t.song)}*\n${esc(t.artist)}`
    : `*${esc(t.title)}*`;
}

function roomPicker(rooms: HomeRoom[], current: string) {
  const option = (r: HomeRoom) => ({
    text: plain(cut(`${r.name} · ${r.code}`, 75)),
    value: r.id,
  });
  const selected = rooms.find((r) => r.id === current);
  return {
    type: 'static_select',
    action_id: 'home_room',
    placeholder: plain('Chọn phòng'),
    options: rooms.slice(0, 100).map(option),
    ...(selected ? { initial_option: option(selected) } : {}),
  };
}

// ------------------------------------------------------------ Home tab

export function homeView(
  v: HomeView,
  rooms: HomeRoom[],
  flash: string | null,
): View {
  const blocks: unknown[] = [];
  const people = v.present.length
    ? `👥 ${v.present.length} người trong phòng`
    : '👥 Chưa ai mở phòng';
  const meta = [
    `Phòng *${v.roomCode}*`,
    people,
    ...(v.listening ? [`🎧 ${v.listening} người nghe cùng`] : []),
    `Cập nhật lúc ${clock(v.at)}`,
  ];
  blocks.push(
    { type: 'header', text: plain(cut(`🎶 ${v.roomName}`, 150)) },
    context(text(meta.join('   ·   '))),
  );
  if (flash) blocks.push(section(flash));
  blocks.push({
    type: 'actions',
    block_id: 'home_top',
    elements: [
      button('🔄 Làm mới', 'home_refresh', v.roomId),
      button('➕ Thêm bài', 'home_add', v.roomId, 'primary'),
      button('🎧 Hỏi DJ', 'home_dj', v.roomId),
      {
        type: 'button',
        text: plain('🌐 Mở phòng trên web'),
        url: v.roomUrl,
        action_id: 'open_room',
      },
      ...(rooms.length > 1 ? [roomPicker(rooms, v.roomId)] : []),
    ],
  });
  blocks.push(divider);

  // ---- now playing
  const p = v.playing;
  if (!p) {
    blocks.push(
      section(
        '🔇 *Loa đang chờ bài*\nChưa có bài nào đang phát. Bấm *➕ Thêm bài* để mở màn cho cả phòng.',
      ),
    );
  } else {
    // A player card: song, progress, then state and who picked it, cover on the right.
    const time = p.durationSec
      ? `\n\n${progress(p.positionSec, p.durationSec)}   ${CHAT.mmss(p.positionSec)} / ${CHAT.mmss(p.durationSec)}`
      : '\n';
    const line = [
      p.paused ? '⏸ Tạm dừng' : '🔴 Đang phát',
      picker(p),
      ...(p.hearts ? [`❤️ ${p.hearts}`] : []),
    ].filter(Boolean);
    blocks.push(
      section(
        `${songLines(p)}${time}\n${line.join('   ·   ')}`,
        thumb(p.thumbnailUrl, p.title),
      ),
    );
    const canVote = !v.vote && !v.blockedUntil;
    blocks.push({
      type: 'actions',
      block_id: 'home_now',
      elements: [
        // Slack refuses a block with two elements sharing an action_id.
        button('❤️', 'react_heart', '❤️'),
        button('🔥', 'react_fire', '🔥'),
        button('👏', 'react_clap', '👏'),
        ...(canVote ? [button('⏭ Qua bài', 'vote_yes', p.itemId)] : []),
        {
          type: 'button',
          text: plain('🎧 Nghe cùng'),
          url: v.roomUrl,
          action_id: 'open_listen',
        },
      ],
    });

    if (v.vote) {
      const who = v.vote.openedBy
        ? `*${esc(v.vote.openedBy)}* muốn qua bài này`
        : 'Có người muốn qua bài này';
      blocks.push(
        divider,
        section(
          `🗳  ${who}\n✅ *${v.vote.votes}*/${v.vote.required}   ·   ❌ *${v.vote.against}*   ·   ⏳ kết thúc lúc ${clock(v.vote.endsAt)}`,
        ),
        {
          type: 'actions',
          block_id: 'home_vote',
          elements: [
            button('✅ Qua bài', 'vote_yes', p.itemId, 'primary'),
            button('❌ Nghe tiếp', 'vote_no', p.itemId, 'danger'),
          ],
        },
      );
    } else if (v.blockedUntil) {
      blocks.push(
        context(
          text(
            `🎶 Cả phòng vừa chọn nghe tiếp bài này. Bỏ phiếu lại được sau ${clock(v.blockedUntil)}.`,
          ),
        ),
      );
    }
  }
  blocks.push(divider);

  // ---- up next
  blocks.push(
    section(
      v.queueLength
        ? `*Tiếp theo*   ·   ${v.queueLength} bài trong hàng chờ`
        : '*Tiếp theo*',
    ),
  );
  if (!v.next.length) {
    blocks.push(
      context(text('Hàng chờ đang trống. Thêm một bài để cả phòng cùng nghe.')),
    );
  }
  v.next.forEach((t, i) => {
    const by = [picker(t), ...(t.hearts ? [`❤️ ${t.hearts}`] : [])].filter(
      Boolean,
    );
    const art = thumb(t.thumbnailUrl, t.title);
    blocks.push(
      context(
        text(`*${i + 1}*`),
        ...(art ? [art] : []),
        text(
          `*${esc(cut(t.song && t.artist ? `${t.song} — ${t.artist}` : t.title, 150))}*${t.durationSec ? `  ${CHAT.mmss(t.durationSec)}` : ''}${by.length ? `\n${by.join('   ·   ')}` : ''}`,
        ),
      ),
    );
  });
  if (v.queueLength > v.next.length) {
    blocks.push(
      context(text(`… và ${v.queueLength - v.next.length} bài nữa trên web.`)),
    );
  }

  // ---- who is here
  if (v.present.length) {
    const names = v.present.slice(0, PRESENT_NAMES).map(esc).join(', ');
    const more = v.present.length - PRESENT_NAMES;
    blocks.push(
      divider,
      context(
        text(
          `👥 *Đang trong phòng:* ${names}${more > 0 ? ` và ${more} người nữa` : ''}`,
        ),
      ),
    );
  }

  blocks.push(
    divider,
    section(
      '*🎧 DJ của phòng*\nBấm *🎧 Hỏi DJ* ở trên, hoặc tag *@Music Room* trong kênh, rồi nói như với người:',
    ),
    context(text(DJ_EXAMPLES.map((e) => `• ${e}`).join('\n'))),
    divider,
    section(`*✨ Mới cập nhật*\n${WHATS_NEW.map((e) => `• ${e}`).join('\n')}`),
    context(
      text(
        '💡 Trang này tự cập nhật khi đổi bài hoặc có bỏ phiếu. Ở kênh, gõ */music help* để xem các lệnh.',
      ),
    ),
  );
  return { type: 'home', private_metadata: v.roomId, blocks };
}

/** What people can ask the DJ (Home and the "Hỏi DJ" modal). */
const DJ_EXAMPLES = [
  '"thêm tôi 3 bài" — thêm bài giống bài đang phát',
  '"thêm bài Lạc Trôi", hoặc dán link YouTube',
  '"vài bài chill", "bài mới của Đen", "3 bài của Sơn Tùng"',
  '"phát ngay bài Nàng Thơ", "đổi bài này thành Mười Năm"',
  '"bỏ qua bài này", "lưu bài này", "xoá bài của tôi"',
  '"bài tiếp theo là gì", "còn bao lâu tới bài của tôi"',
];

/** Recent changes worth telling Slack users about (newest first). */
const WHATS_NEW = [
  '*Hỏi DJ ngay trên trang này*: bấm *🎧 Hỏi DJ*, không cần vào kênh.',
  'DJ hiểu nhanh *"thêm tôi 4 bài"* (bài giống bài đang phát) và *link YouTube* dán vào.',
  '*Số phiếu tối thiểu để qua bài*: người nghe qua Slack được tính công bằng hơn (quản trị viên đặt trong tab *Cài đặt* trên web).',
  'Trên web: ảnh đại diện và *logo Slack* hiện cạnh tên bạn trong *Mọi người*; chủ phòng có 👑.',
  'Video không còn tự bật phụ đề; *Yêu thích* và *playlist* tự cập nhật, không cần tải lại.',
];

/** No channel of this workspace is linked to a room yet. */
export function setupView(): View {
  return {
    type: 'home',
    blocks: [
      { type: 'header', text: plain('🎶 Music Room') },
      section(
        'Nghe nhạc chung văn phòng: thêm bài, thả tim, bỏ phiếu qua bài — ngay trên Slack.',
      ),
      divider,
      section(
        '*Bắt đầu*\nWorkspace này chưa nối với phòng nào. Quản trị viên phòng vào kênh muốn dùng và gõ:\n`/music connect &lt;MÃ PHÒNG&gt; &lt;PIN&gt;`\nRồi bấm *Làm mới* ở đây.',
      ),
      {
        type: 'actions',
        block_id: 'home_top',
        elements: [button('🔄 Làm mới', 'home_refresh', '')],
      },
      divider,
      context(
        text(
          '💡 Mã PIN chỉ gõ bằng `/music connect` (chỉ bạn thấy), đừng tag bot kèm PIN.',
        ),
      ),
    ],
  };
}

/** Shown briefly when Home could not be built (room gone, server busy). */
export function errorView(message: string): View {
  return {
    type: 'home',
    blocks: [
      { type: 'header', text: plain('🎶 Music Room') },
      section(message),
      {
        type: 'actions',
        block_id: 'home_top',
        elements: [button('🔄 Làm mới', 'home_refresh', '')],
      },
    ],
  };
}

// ------------------------------------------------------------ "Hỏi DJ" modal

export const DJ_CALLBACK = 'ask_dj';

/** The "Hỏi DJ" modal; kept whole in private_metadata like the "Thêm bài" one. */
export interface DjState {
  roomId: string;
  roomName: string;
  /** The last request and the DJ's answer (null while the DJ is still working). */
  asked: string | null;
  answer: string | null;
  /** Bumped to empty the input after each request. */
  round: number;
}

/** The answer kept in private_metadata (Slack allows 3000 characters there). */
const DJ_ANSWER_MAX = 1800;

export function djModal(s: DjState): View {
  s = { ...s, answer: s.answer === null ? null : cut(s.answer, DJ_ANSWER_MAX) };
  const blocks: unknown[] = [
    context(
      text(
        `Phòng *${esc(s.roomName)}*   ·   Nói với DJ như với người. Bài DJ thêm được ghi là của bạn.`,
      ),
    ),
  ];
  if (s.asked)
    blocks.push(
      section(`*Bạn:* ${esc(s.asked)}`),
      section(
        `🎧 *DJ:* ${s.answer === null ? '⏳ Đang nghĩ…' : esc(s.answer)}`,
      ),
      divider,
    );
  blocks.push(
    {
      type: 'input',
      block_id: `dj${s.round}`,
      label: plain(s.asked ? 'Hỏi tiếp' : 'Bạn muốn DJ làm gì?'),
      element: {
        type: 'plain_text_input',
        action_id: 'q',
        placeholder: plain('Ví dụ: thêm tôi 3 bài giống bài này'),
        max_length: 300,
      },
    },
    context(text(DJ_EXAMPLES.map((e) => `• ${e}`).join('\n'))),
  );
  return {
    type: 'modal',
    callback_id: DJ_CALLBACK,
    title: plain('Hỏi DJ'),
    submit: plain('Gửi'),
    close: plain('Xong'),
    private_metadata: JSON.stringify(s),
    blocks,
  };
}

// ------------------------------------------------------------ "Thêm bài" modal

export const ADD_CALLBACK = 'add_song';

export interface AddResult {
  id: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
}

/** What the modal shows; kept whole in private_metadata so a click can redraw it. */
export interface AddState {
  roomId: string;
  roomName: string;
  q: string;
  results: AddResult[];
  /** externalIds already added from this modal. */
  added: string[];
  /** A line above the results: progress, success or what went wrong. */
  notice: string | null;
  /** Bumped to empty the input (a new block id drops what was typed). */
  round: number;
}

export const toResult = (t: TrackSummary): AddResult => ({
  id: t.externalId,
  title: cut(t.title, 150),
  channel: t.channel ? cut(t.channel, 60) : null,
  durationSec: t.durationSec,
  thumbnailUrl: t.thumbnailUrl,
});

export function addModal(s: AddState): View {
  const blocks: unknown[] = [
    context(
      text(
        `Phòng *${esc(s.roomName)}*   ·   Dán link YouTube để thêm ngay, hoặc gõ tên bài rồi bấm *Tìm*.`,
      ),
    ),
    {
      type: 'input',
      block_id: `q${s.round}`,
      label: plain('Tên bài hoặc link YouTube'),
      element: {
        type: 'plain_text_input',
        action_id: 'q',
        placeholder: plain('Ví dụ: Lạc Trôi, hoặc https://youtu.be/…'),
        max_length: 200,
        ...(s.q ? { initial_value: s.q } : {}),
      },
    },
  ];
  if (s.notice) blocks.push(section(s.notice));
  s.results.forEach((r, i) => {
    const sub = [
      r.channel ? esc(r.channel) : null,
      r.durationSec ? CHAT.mmss(r.durationSec) : null,
    ]
      .filter(Boolean)
      .join('   ·   ');
    blocks.push(
      divider,
      section(
        `*${esc(r.title)}*${sub ? `\n${sub}` : ''}`,
        thumb(r.thumbnailUrl, r.title),
      ),
      s.added.includes(r.id)
        ? context(text('✅ Đã thêm vào hàng chờ'))
        : {
            type: 'actions',
            block_id: `res${i}`,
            elements: [button('➕ Thêm vào hàng chờ', 'add', r.id, 'primary')],
          },
    );
  });
  return {
    type: 'modal',
    callback_id: ADD_CALLBACK,
    title: plain('Thêm bài'),
    submit: plain('Tìm'),
    close: plain('Xong'),
    private_metadata: JSON.stringify(s),
    blocks,
  };
}

export const addNotice = {
  searching: (q: string) => `🔎 Đang tìm "${esc(q)}"…`,
  adding: '⏳ Đang thêm bài…',
  added: (title: string) => `✅ Đã thêm *${esc(title)}* vào hàng chờ.`,
  noResults: (q: string) => esc(CHAT.noResults(q)),
  error: (message: string) => `⚠️ ${message}`,
};
