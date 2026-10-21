import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { parseYouTubeVideo, type Reaction, REACTIONS } from '../../contracts';
import { DjBrainService } from '../../dj/dj-brain.service';
import { RoomActivityService } from '../../rooms/room-activity.service';
import { RoomStateService } from '../../state/room-state.service';
import {
  type ChatUser,
  ChatRoomService,
  type HomeView,
} from '../chat-room.service';
import { CHAT, chatError } from '../chat-text';
import { SlackApi } from './slack-api.service';
import { djSlackOut, esc } from './slack-blocks';
import {
  ADD_CALLBACK,
  addModal,
  addNotice,
  type AddState,
  DJ_CALLBACK,
  djModal,
  type DjState,
  errorView,
  homeView,
  setupView,
  toResult,
  type View,
} from './slack-home';

/** Someone who opened Home this recently gets it redrawn when the room changes. */
const WATCH_MS = 30 * 60_000;
/** At most this many Homes redrawn per room change (Slack allows ~100 views.publish a minute). */
const WATCH_MAX = 40;
/** Room changes come in bursts (song ends → next starts → votes clear): wait for quiet. */
const REFRESH_DEBOUNCE_MS = 1500;
/** A line such as "✅ Đã thêm …" stays on Home this long. */
const FLASH_MS = 60_000;
/** Slack wants a modal submission answered within 3 s; slower work finishes in place. */
const SUBMIT_WAIT_MS = 2200;

interface Viewer {
  teamId: string;
  userId: string;
  at: number;
}

/** The parts of a Slack interaction payload Home and the modal use. */
export interface SlackViewPayload {
  type?: string;
  trigger_id?: string;
  user?: { id?: string; username?: string; name?: string; team_id?: string };
  team?: { id?: string };
  actions?: {
    action_id?: string;
    value?: string;
    selected_option?: { value?: string };
  }[];
  view?: {
    id?: string;
    type?: string;
    callback_id?: string;
    private_metadata?: string;
    state?: {
      values?: Record<string, Record<string, { value?: string | null }>>;
    };
  };
}

const userKey = (teamId: string, userId: string) => `${teamId}|${userId}`;

/**
 * The bot's Home tab: the room's player, vote and queue with buttons, one view per person.
 * Slack only shows what we last published, so Homes opened in the last half hour are
 * redrawn when the song, the vote or the queue changes.
 */
@Injectable()
export class SlackHomeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlackHomeService.name);
  /** roomId → people who recently looked at that room on Home. */
  private readonly viewers = new Map<string, Map<string, Viewer>>();
  /** team|user → the room they picked on Home (also kept in the view's metadata). */
  private readonly choice = new Map<string, string>();
  private readonly flashes = new Map<string, { text: string; at: number }>();
  /** roomId → what Home last showed, so unrelated changes (chat, reactions) redraw nothing. */
  private readonly shown = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly slack: SlackApi,
    private readonly chat: ChatRoomService,
    private readonly state: RoomStateService,
    private readonly roomActivity: RoomActivityService,
    private readonly brain: DjBrainService,
  ) {}

  onModuleInit(): void {
    if (!this.slack.enabled) return;
    this.state.onCommitted((roomId) => {
      if (this.viewers.has(roomId)) this.later(roomId);
    });
    // Viewers of a deleted room see another room (or setup) the next time Home is drawn.
    this.state.onDeleted((roomId) => {
      this.viewers.delete(roomId);
      this.shown.delete(roomId);
      const t = this.timers.get(roomId);
      if (t) clearTimeout(t);
      this.timers.delete(roomId);
      for (const [k, id] of this.choice)
        if (id === roomId) this.choice.delete(k);
    });
  }

  onModuleDestroy(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ------------------------------------------------------------ publishing

  /**
   * Draws `userId`'s Home. `wanted`: the room they were looking at (view metadata); falls
   * back to their last pick, then to the most recently linked room of the workspace.
   * `redraw`: an automatic refresh, which does not count as the person looking again.
   */
  async publish(
    teamId: string,
    userId: string,
    wanted?: string | null,
    redraw = false,
  ) {
    const key = userKey(teamId, userId);
    try {
      const rooms = await this.chat.roomsOfTeam('slack', teamId);
      if (!rooms.length) {
        await this.slack.publishView(userId, setupView());
        return;
      }
      const pick = [wanted, this.choice.get(key)].find(
        (id) => id && rooms.some((r) => r.id === id),
      );
      const roomId = pick ?? rooms[0].id;
      this.choice.set(key, roomId);
      const v = await this.chat.home(roomId);
      if (!v) {
        await this.slack.publishView(userId, setupView());
        return;
      }
      if (!redraw) {
        this.watch(roomId, teamId, userId);
        // Opening Home (not our automatic redraw) counts as using the room.
        this.roomActivity.touch(roomId);
      }
      await this.slack.publishView(userId, homeView(v, rooms, this.flash(key)));
    } catch (e) {
      this.logger.warn(`slack home failed for ${userId}: ${String(e)}`);
      await this.slack.publishView(userId, errorView(chatError(e)));
    }
  }

  private watch(roomId: string, teamId: string, userId: string): void {
    for (const [id, people] of this.viewers) {
      if (id !== roomId) people.delete(userKey(teamId, userId));
      if (!people.size) this.viewers.delete(id);
    }
    const people = this.viewers.get(roomId) ?? new Map<string, Viewer>();
    people.delete(userKey(teamId, userId));
    people.set(userKey(teamId, userId), { teamId, userId, at: Date.now() });
    // Oldest first: past the cap, the person who looked longest ago stops being redrawn.
    while (people.size > WATCH_MAX)
      people.delete(people.keys().next().value as string);
    this.viewers.set(roomId, people);
  }

  private flash(key: string): string | null {
    const f = this.flashes.get(key);
    if (!f) return null;
    if (Date.now() - f.at > FLASH_MS) {
      this.flashes.delete(key);
      return null;
    }
    return f.text;
  }

  /** Shows `text` at the top of the person's Home and redraws it. */
  private async notify(
    teamId: string,
    userId: string,
    text: string,
    roomId?: string | null,
  ) {
    this.flashes.set(userKey(teamId, userId), { text, at: Date.now() });
    await this.publish(teamId, userId, roomId);
  }

  private later(roomId: string): void {
    if (this.timers.has(roomId)) return;
    const t = setTimeout(() => {
      this.timers.delete(roomId);
      void this.refresh(roomId).catch((e: unknown) =>
        this.logger.warn(
          `slack home refresh failed for ${roomId}: ${String(e)}`,
        ),
      );
    }, REFRESH_DEBOUNCE_MS);
    t.unref();
    this.timers.set(roomId, t);
  }

  /** Redraws the room's recent viewers if something they can see changed. */
  private async refresh(roomId: string): Promise<void> {
    const people = this.viewers.get(roomId);
    if (!people) return;
    const now = Date.now();
    for (const [k, p] of people) if (now - p.at > WATCH_MS) people.delete(k);
    if (!people.size) {
      this.viewers.delete(roomId);
      this.shown.delete(roomId);
      return;
    }
    const v = await this.chat.home(roomId);
    if (!v) return;
    const key = visibleKey(v);
    if (this.shown.get(roomId) === key) return;
    this.shown.set(roomId, key);
    for (const p of [...people.values()])
      await this.publish(p.teamId, p.userId, roomId, true);
  }

  // ------------------------------------------------------------ clicks on Home

  async homeAction(p: SlackViewPayload): Promise<void> {
    const a = p.actions?.[0];
    const teamId = p.team?.id ?? p.user?.team_id ?? '';
    const userId = p.user?.id ?? '';
    if (!a || !userId) return;
    const roomId = p.view?.private_metadata || null;
    switch (a.action_id) {
      case 'open_room':
      case 'open_listen':
        return;
      case 'home_refresh':
        return this.publish(teamId, userId, roomId);
      case 'home_room':
        return this.publish(teamId, userId, a.selected_option?.value);
      case 'home_add':
        return this.openAdd(p, teamId, roomId);
      case 'home_dj':
        return this.openDj(p, teamId, roomId);
    }
    if (!(await this.allowed(teamId, roomId)))
      return this.publish(teamId, userId);
    try {
      const user = await this.user(p, teamId);
      if (a.action_id === 'vote_yes' || a.action_id === 'vote_no') {
        const approve = a.action_id === 'vote_yes';
        await this.chat.vote(roomId!, user, approve, a.value);
        return this.notify(teamId, userId, CHAT.voted(approve), roomId);
      }
      if (a.action_id?.startsWith('react_')) {
        if (!(REACTIONS as readonly string[]).includes(a.value ?? '')) return;
        await this.chat.react(roomId!, user, a.value as Reaction);
        return this.notify(
          teamId,
          userId,
          `${a.value} Đã gửi tới cả phòng.`,
          roomId,
        );
      }
    } catch (e) {
      await this.notify(teamId, userId, `⚠️ ${chatError(e)}`, roomId);
    }
  }

  /** private_metadata is ours, but the room may have been unlinked since. */
  private async allowed(
    teamId: string,
    roomId: string | null,
  ): Promise<boolean> {
    if (!roomId) return false;
    const rooms = await this.chat.roomsOfTeam('slack', teamId);
    return rooms.some((r) => r.id === roomId);
  }

  private user(p: SlackViewPayload, teamId: string): Promise<ChatUser> {
    return this.slack.chatUser(
      teamId,
      p.user?.id ?? '',
      p.user?.username ?? p.user?.name ?? '',
    );
  }

  // ------------------------------------------------------------ "Thêm bài" modal

  private async openAdd(
    p: SlackViewPayload,
    teamId: string,
    roomId: string | null,
  ) {
    if (!p.trigger_id || !(await this.allowed(teamId, roomId))) {
      return this.publish(teamId, p.user?.id ?? '');
    }
    const rooms = await this.chat.roomsOfTeam('slack', teamId);
    const room = rooms.find((r) => r.id === roomId)!;
    await this.slack.openView(
      p.trigger_id,
      addModal({
        roomId: room.id,
        roomName: room.name,
        q: '',
        results: [],
        added: [],
        notice: null,
        round: 0,
      }),
    );
  }

  // ------------------------------------------------------------ "Hỏi DJ" modal

  private async openDj(
    p: SlackViewPayload,
    teamId: string,
    roomId: string | null,
  ) {
    if (!p.trigger_id || !(await this.allowed(teamId, roomId))) {
      return this.publish(teamId, p.user?.id ?? '');
    }
    const rooms = await this.chat.roomsOfTeam('slack', teamId);
    const room = rooms.find((r) => r.id === roomId)!;
    await this.slack.openView(
      p.trigger_id,
      djModal({
        roomId: room.id,
        roomName: room.name,
        asked: null,
        answer: null,
        round: 0,
      }),
    );
  }

  /**
   * "Gửi" in the "Hỏi DJ" modal: the DJ answers as it does to "@Music Room …" in a channel.
   * The AI can take longer than Slack waits: "Đang nghĩ…" first, the answer when it comes.
   * Songs added or the room changed: Home says so too.
   */
  private async submitDj(
    p: SlackViewPayload,
    s: DjState,
  ): Promise<Record<string, unknown>> {
    const teamId = p.team?.id ?? p.user?.team_id ?? '';
    const userId = p.user?.id ?? '';
    const blockId = `dj${s.round}`;
    const q = (p.view?.state?.values?.[blockId]?.q?.value ?? '').trim();
    if (!q)
      return {
        response_action: 'errors',
        errors: { [blockId]: 'Hãy gõ điều bạn muốn DJ làm.' },
      };
    if (!(await this.allowed(teamId, s.roomId)))
      return {
        response_action: 'errors',
        errors: { [blockId]: 'Phòng này không còn nối với Slack.' },
      };
    const next = { ...s, asked: q, round: s.round + 1 };
    const work: Promise<string> = (async () => {
      const user = await this.user(p, teamId);
      const { actor } = await this.chat.asMember(s.roomId, user);
      const reply = await this.brain.handle({
        actor,
        request: q,
        platform: 'slack',
      });
      const view = await this.chat.now(s.roomId);
      const out = djSlackOut(reply, view?.roomUrl ?? null);
      if (reply.kind === 'added' || reply.kind === 'done')
        void this.notify(teamId, userId, `🎧 ${out.text}`, s.roomId);
      return out.text;
    })().catch((e: unknown) => `⚠️ ${esc(chatError(e))}`);

    const quick = await Promise.race([
      work,
      new Promise<null>((r) => setTimeout(() => r(null), SUBMIT_WAIT_MS)),
    ]);
    if (quick !== null)
      return {
        response_action: 'update',
        view: djModal({ ...next, answer: quick }),
      };
    const viewId = p.view?.id;
    void work.then((answer) =>
      viewId
        ? this.slack.updateView(viewId, djModal({ ...next, answer }))
        : undefined,
    );
    return {
      response_action: 'update',
      view: djModal({ ...next, answer: null }),
    };
  }

  private static djStateOf(p: SlackViewPayload): DjState | null {
    try {
      const s = JSON.parse(p.view?.private_metadata ?? '') as DjState;
      return s && typeof s.roomId === 'string' ? s : null;
    } catch {
      return null;
    }
  }

  private static stateOf(p: SlackViewPayload): AddState | null {
    try {
      const s = JSON.parse(p.view?.private_metadata ?? '') as AddState;
      return s && typeof s.roomId === 'string' ? s : null;
    } catch {
      return null;
    }
  }

  /**
   * "Tìm" in the modal. Returns Slack's answer: an inline error, or the modal redrawn. Work
   * that takes longer than Slack waits shows "…" first and redraws the modal when done.
   */
  async submit(p: SlackViewPayload): Promise<Record<string, unknown>> {
    const s = SlackHomeService.stateOf(p);
    const teamId = p.team?.id ?? p.user?.team_id ?? '';
    const userId = p.user?.id ?? '';
    if (p.view?.callback_id === DJ_CALLBACK) {
      const d = SlackHomeService.djStateOf(p);
      return d ? this.submitDj(p, d) : {};
    }
    if (p.view?.callback_id !== ADD_CALLBACK || !s) return {};
    const blockId = `q${s.round}`;
    const q = (p.view.state?.values?.[blockId]?.q?.value ?? '').trim();
    if (!q) {
      return {
        response_action: 'errors',
        errors: { [blockId]: 'Hãy nhập tên bài hoặc dán link YouTube.' },
      };
    }
    if (!(await this.allowed(teamId, s.roomId))) {
      return {
        response_action: 'errors',
        errors: { [blockId]: 'Phòng này không còn nối với Slack.' },
      };
    }
    const user = await this.user(p, teamId);
    const isLink = Boolean(parseYouTubeVideo(q));

    const work: Promise<{ view?: View; error?: string }> = isLink
      ? this.chat.add(s.roomId, user, q).then(
          (r) => {
            void this.notify(
              teamId,
              userId,
              addNotice.added(r.title),
              s.roomId,
            );
            return {
              view: addModal({
                ...s,
                q: '',
                results: [],
                notice: addNotice.added(r.title),
                round: s.round + 1,
              }),
            };
          },
          (e: unknown) => ({ error: chatError(e) }),
        )
      : this.chat.find(s.roomId, user, q).then(
          (found) => ({
            view: addModal({
              ...s,
              q,
              results: found.map(toResult),
              added: [],
              notice: found.length ? null : addNotice.noResults(q),
            }),
          }),
          (e: unknown) => ({
            view: addModal({
              ...s,
              q,
              results: [],
              notice: addNotice.error(chatError(e)),
            }),
          }),
        );

    const quick = await Promise.race([
      work,
      new Promise<null>((r) => setTimeout(() => r(null), SUBMIT_WAIT_MS)),
    ]);
    if (quick?.error)
      return { response_action: 'errors', errors: { [blockId]: quick.error } };
    if (quick?.view) return { response_action: 'update', view: quick.view };

    // Still working: show progress now, the outcome when it arrives.
    const viewId = p.view.id;
    void work.then((done) => {
      if (!viewId) return;
      const view =
        done.view ??
        addModal({
          ...s,
          q,
          results: [],
          notice: addNotice.error(done.error ?? ''),
        });
      return this.slack.updateView(viewId, view);
    });
    return {
      response_action: 'update',
      view: addModal({
        ...s,
        q,
        results: [],
        notice: isLink ? addNotice.adding : addNotice.searching(q),
      }),
    };
  }

  /** "➕ Thêm vào hàng chờ" on a search result in the modal. */
  async modalAction(p: SlackViewPayload): Promise<void> {
    const a = p.actions?.[0];
    const s = SlackHomeService.stateOf(p);
    const teamId = p.team?.id ?? p.user?.team_id ?? '';
    const userId = p.user?.id ?? '';
    const viewId = p.view?.id;
    if (a?.action_id !== 'add' || !s || !viewId) return;
    if (!(await this.allowed(teamId, s.roomId))) return;
    try {
      const user = await this.user(p, teamId);
      const r = await this.chat.add(
        s.roomId,
        user,
        `https://youtu.be/${a.value ?? ''}`,
      );
      await this.slack.updateView(
        viewId,
        addModal({
          ...s,
          added: [...s.added, a.value ?? ''],
          notice: addNotice.added(r.title),
        }),
      );
      await this.notify(teamId, userId, addNotice.added(r.title), s.roomId);
    } catch (e) {
      await this.slack.updateView(
        viewId,
        addModal({ ...s, notice: addNotice.error(chatError(e)) }),
      );
    }
  }
}

/** What a viewer of Home would notice; the playback position alone does not count. */
function visibleKey(v: HomeView): string {
  return JSON.stringify([
    v.roomName,
    v.playing?.itemId,
    v.playing?.paused,
    v.playing?.hearts,
    v.vote,
    v.blockedUntil,
    v.queueLength,
    v.next.map((t) => [t.title, t.hearts]),
    v.present.length,
    v.listening,
  ]);
}
