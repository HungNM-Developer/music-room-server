import { djText } from '../../dj/dj-text';
import type { SlackOut } from './slack-commands.service';
import type { DjReply, TrackSummary } from '../../contracts';
import type { NowView } from '../chat-room.service';
import { CHAT } from '../chat-text';

// Block Kit messages. Action ids are read back in SlackController.

export interface VoteCard {
  itemId: string;
  title: string;
  thumbnailUrl: string | null;
  openedBy: string | null;
  votes: number;
  required: number;
  against: number;
  secondsLeft: number;
}

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const button = (
  text: string,
  actionId: string,
  value: string,
  style?: 'primary' | 'danger',
) => ({
  type: 'button',
  text: { type: 'plain_text', text, emoji: true },
  action_id: actionId,
  value,
  ...(style ? { style } : {}),
});
export const thumb = (url: string | null, alt: string) =>
  url
    ? { type: 'image', image_url: url, alt_text: alt.slice(0, 2000) }
    : undefined;

export function nowMessage(v: NowView): { text: string; blocks: unknown[] } {
  const head = `🎶 *<${v.roomUrl}|${esc(v.roomName)}>* · ${v.roomCode}`;
  if (!v.playing) {
    return {
      text: CHAT.idle,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `${head}\n${CHAT.idle}` },
        },
      ],
    };
  }
  const p = v.playing;
  const when = p.durationSec
    ? ` · ${CHAT.mmss(p.positionSec)} / ${CHAT.mmss(p.durationSec)}`
    : '';
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${head}\n${p.paused ? '⏸ Tạm dừng' : '🔴 Đang phát'}${when}\n*${esc(p.title)}*${p.pickedBy ? `\n${esc(p.pickedBy)} chọn` : ''}`,
      },
      ...(thumb(p.thumbnailUrl, p.title)
        ? { accessory: thumb(p.thumbnailUrl, p.title) }
        : {}),
    },
  ];
  if (v.next.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Tiếp theo: ${v.next
            .slice(0, 3)
            .map((n) => esc(n.title))
            .join(' · ')}`,
        },
      ],
    });
  }
  blocks.push({
    type: 'actions',
    elements: [
      // Slack refuses a message whose block has two elements with the same action_id.
      button('❤️', 'react_heart', '❤️'),
      button('🔥', 'react_fire', '🔥'),
      button('👏', 'react_clap', '👏'),
      button('⏭ Qua bài', 'vote_yes', p.itemId),
      {
        type: 'button',
        text: { type: 'plain_text', text: '🎧 Nghe cùng', emoji: true },
        url: v.roomUrl,
        action_id: 'open_room',
      },
    ],
  });
  return { text: `Đang phát: ${p.title}`, blocks };
}

export function voteMessage(c: VoteCard): { text: string; blocks: unknown[] } {
  const who = c.openedBy
    ? `*${esc(c.openedBy)}* muốn qua bài`
    : 'Có người muốn qua bài';
  return {
    text: `${c.openedBy ?? 'Có người'} muốn qua bài ${c.title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `⏭ ${who}\n*${esc(c.title)}*` },
        ...(thumb(c.thumbnailUrl, c.title)
          ? { accessory: thumb(c.thumbnailUrl, c.title) }
          : {}),
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `✅ ${c.votes}/${c.required} · ❌ ${c.against} · còn ${c.secondsLeft} giây`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          button('✅ Qua bài', 'vote_yes', c.itemId, 'primary'),
          button('❌ Nghe tiếp', 'vote_no', c.itemId, 'danger'),
        ],
      },
    ],
  };
}

export function voteResultMessage(
  title: string,
  skipped: boolean,
): { text: string; blocks: unknown[] } {
  const text = skipped
    ? `⏭ Đã qua bài *${esc(title)}*`
    : `🎶 Cả phòng muốn nghe tiếp *${esc(title)}*`;
  return {
    text: text.replace(/\*/g, ''),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

/** The owner deleted the room: the channel is unlinked (also replaces an open vote card). */
export function roomDeletedMessage(name: string): {
  text: string;
  blocks: unknown[];
} {
  const text = `🎶 Phòng *${esc(name)}* đã bị xoá nên kênh này đã tự bỏ nối.`;
  return {
    text: text.replace(/\*/g, ''),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

export function searchMessage(
  q: string,
  results: TrackSummary[],
): { text: string; blocks: unknown[] } {
  if (!results.length) return { text: CHAT.noResults(q), blocks: [] };
  return {
    text: `Kết quả cho "${q}"`,
    blocks: results.map((t) => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${esc(t.title)}*\n${esc(t.channel ?? '')}${t.durationSec ? ` · ${CHAT.mmss(t.durationSec)}` : ''}`,
      },
      accessory: button('Thêm', 'add', t.externalId, 'primary'),
    })),
  };
}

export function queueMessage(v: NowView): string {
  if (!v.next.length) return CHAT.queueEmpty;
  return [
    CHAT.queueTitle,
    ...v.next.map(
      (n, i) =>
        `${i + 1}. ${esc(n.title)}${n.pickedBy ? ` — ${esc(n.pickedBy)}` : ''}`,
    ),
  ].join('\n');
}

const DJ_HELP = 'Gõ `/music help` để xem mọi lệnh.';

/**
 * "@Music Room <câu>": the DJ's answer for Slack (spec 2026-10-18-dj-chat). Always for the
 * channel (user's choice, 2026-10-21): everyone sees what was asked and what the DJ did.
 */
export function djSlackOut(r: DjReply, roomUrl: string | null): SlackOut {
  // Escaped: the text carries the AI's words and what people typed (song names, the
  // request), and it goes to the whole channel — "<!channel>" or "<url|…>" must stay text.
  const text = esc(djText(r));
  if (r.kind === 'added' || r.kind === 'done')
    return { visibility: 'public', text };
  if (r.kind === 'guide') {
    const cmd =
      r.guide === 'skip'
        ? '`/music skip`'
        : r.guide === 'add'
          ? `\`/music add ${r.query ? esc(r.query) : '&lt;tên bài&gt;'}\``
          : r.guide === 'myItem'
            ? '`/music queue`'
            : null;
    const lines = [
      text,
      cmd ? `Trên Slack: gõ ${cmd}.` : 'Việc này làm trên trang phòng.',
      DJ_HELP,
    ];
    const out: SlackOut = { visibility: 'public', text: lines.join('\n') };
    if (!cmd && roomUrl)
      out.blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Mở phòng', emoji: true },
              url: roomUrl,
              action_id: 'open_room',
            },
          ],
        },
      ];
    return out;
  }
  if (r.kind === 'info' && r.info?.kind === 'myNext')
    return {
      visibility: 'public',
      text: `${text}\nGõ \`/music queue\` để xem hàng chờ.`,
    };
  if (r.kind === 'other' || r.kind === 'hello')
    return { visibility: 'public', text: `${text}\n${DJ_HELP}` };
  return { visibility: 'public', text };
}
