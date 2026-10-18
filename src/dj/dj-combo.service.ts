import { Injectable } from '@nestjs/common';
import { DjService } from '../ai/dj.service';
import { AppError } from '../common/app-error';
import {
  ADD_MANY_MAX,
  type DjAction,
  type DjStep,
  type ErrorCode,
  normalizeQuery,
  type QueueItemView,
} from '../contracts';
import type { Member } from '../generated/prisma/client';
import { LibraryService } from '../library/library.service';
import { InnerTubeProvider } from '../music/innertube.provider';
import { SearchService } from '../music/search.service';
import { PlaybackService } from '../playback/playback.service';
import { PlaylistsService } from '../playlists/playlists.service';
import { QueueService } from '../queue/queue.service';
import type { Actor } from '../state/room-state.service';
import { SnapshotService } from '../state/snapshot.service';
import { etaSec } from './dj-eta';
import { DjFinder } from './dj-find';
import { findFresh } from './dj-fresh';
import {
  MAX_SONGS,
  type Find,
  type Pin,
  type Plan,
  type PlanStep,
  type Target,
} from './dj-plan';
import { DjResolver, selectTargets } from './dj-resolve';

/** The song cannot go in, but the next candidate might. */
const TRY_NEXT: ErrorCode[] = [
  'ALREADY_QUEUED',
  'TRACK_BLOCKED',
  'TRACK_TOO_LONG',
  'PLAYED_RECENTLY',
  'TRACK_NOT_EMBEDDABLE',
  'TRACK_NOT_FOUND',
  'TRACK_LIVE',
];
/**
 * A song asked for by name: only another upload of the same song that can play. Never around a
 * block, and "đã phát gần đây" / "đang chờ" are the answer, not a reason to pick another version.
 */
const TRY_NEXT_EXACT: ErrorCode[] = [
  'TRACK_TOO_LONG',
  'TRACK_NOT_EMBEDDABLE',
  'TRACK_NOT_FOUND',
  'TRACK_LIVE',
];
/** No further song of this request can go in. */
const STOP_ADDING: ErrorCode[] = ['QUEUE_LIMIT', 'FORBIDDEN', 'RATE_LIMITED'];
/** Candidates tried beyond the songs wanted (each try is one of the asker's adds). */
const SPARE_TRIES = 4;

export type AiPicks = (
  text: string,
  count: number,
) => Promise<{ artist: string; song: string }[] | null>;

interface Run {
  me: Member;
  actor: Actor;
  steps: DjStep[];
  /** Sent with the first song that goes in. */
  wish?: string;
  /** The asker can add no more (queue limit…). */
  full: boolean;
  aiPicks: AiPicks;
}

function failed(action: DjAction, e: unknown): DjStep {
  if (e instanceof AppError)
    return {
      action,
      ok: false,
      errorCode: e.code,
      ...(e.params ? { errorParams: e.params } : {}),
    };
  throw e;
}

/** Suggestions shown when the asker gave no number. */
const SUGGEST_DEFAULT = 3;

/**
 * The asker's playlist with this name: the same name, else (not `exact`) the one playlist whose
 * name holds what was said ("chill" → "Chill Vibes"; never "Chill 2" → "Chill").
 */
function playlistNamed<T extends { name: string }>(
  lists: T[],
  name: string,
  exact = false,
): { one: T | null; several: T[] } {
  const q = normalizeQuery(name);
  const same = lists.filter((l) => normalizeQuery(l.name) === q);
  if (same.length) return { one: same[0], several: [] };
  if (exact || q.length < 3) return { one: null, several: [] };
  const near = lists.filter((l) => normalizeQuery(l.name).includes(q));
  return near.length === 1
    ? { one: near[0], several: [] }
    : { one: null, several: near };
}

/**
 * Carries out a combo plan (dj-plan) as the asker, step by step, through the same services as
 * the room page: every right and limit applies. Never throws for a refused step: it is
 * reported in the answer, and the next steps still run.
 */
@Injectable()
export class DjComboService {
  constructor(
    private readonly queue: QueueService,
    private readonly playback: PlaybackService,
    private readonly library: LibraryService,
    private readonly snapshots: SnapshotService,
    private readonly search: SearchService,
    private readonly innertube: InnerTubeProvider,
    private readonly dj: DjService,
    private readonly finder: DjFinder,
    private readonly resolver: DjResolver,
    private readonly playlists: PlaylistsService,
  ) {}

  async run(
    plan: Plan,
    me: Member,
    actor: Actor,
    aiPicks: AiPicks,
  ): Promise<DjStep[]> {
    const run: Run = {
      me,
      actor,
      steps: [],
      wish: plan.wish,
      full: false,
      aiPicks,
    };
    for (const step of plan.steps) await this.step(run, step);
    return run.steps;
  }

  private async step(run: Run, s: PlanStep): Promise<void> {
    // "thêm 10 bài": up to MAX_SONGS, and the answer says so.
    if ('asked' in s && s.asked)
      run.steps.push({
        action: 'add',
        ok: false,
        reason: 'tooMany',
        got: MAX_SONGS,
        wanted: s.asked,
      });
    switch (s.do) {
      case 'add':
        return this.findAndAdd(
          run,
          { titles: s.titles },
          s.titles.length,
          s.pin,
        );
      case 'addArtist': {
        const { videos, verified } = await findFresh(
          { innertube: this.innertube, search: this.search },
          run.me.id,
          s.artist,
          s.mode,
        );
        return this.addSongs(
          run,
          videos.map((v) => v.externalId),
          s.count,
          {
            pin: s.pin,
            query: s.artist,
            fresh: s.mode !== 'top' && verified ? s.mode : null,
          },
        );
      }
      case 'addVague': {
        const picks = await run.aiPicks(s.text, s.count);
        if (picks === null) {
          run.steps.push({ action: 'add', ok: false, reason: 'busy' });
          return;
        }
        return this.addSongs(run, this.pickIds(run, picks), s.count, {
          pin: s.pin,
          query: s.text,
        });
      }
      case 'addPicks':
        return this.addSongs(run, this.pickIds(run, s.picks), s.picks.length, {
          pin: s.pin,
        });
      case 'addFrom': {
        const tracks =
          s.source === 'played'
            ? (await this.library.roomLibrary(run.actor, 'recent')).items.map(
                (i) => i.track,
              )
            : (await this.library.listFavorites(run.actor)).tracks;
        return this.addSongs(
          run,
          tracks.map((t) => t.externalId),
          s.count,
          { pin: s.pin },
        );
      }
      case 'heart':
        return this.heart(run, s.target);
      case 'remove':
        return this.remove(run, s.target);
      case 'pin':
        return this.pinTarget(run, s.target, Boolean(s.now));
      case 'replace':
        return this.replace(run, s.from, s.to);
      case 'skip':
        for (let i = 0; i < (s.count ?? 1); i++)
          if (!(await this.skip(run))) return;
        return;
      case 'pause':
      case 'resume':
        return this.control(run, s.do);
      case 'find':
        return s.suggest
          ? this.suggest(run, s.find, s.count)
          : this.findAndAdd(run, s.find, s.count, s.pin);
      case 'replaceWith':
        return this.replaceWith(run, s.target, s.find);
      case 'save':
        return this.save(run);
      case 'playlistSave':
        return this.playlistSave(run, s.playlist);
      case 'playlistCreate':
        return this.playlistCreate(run, s.name, s.find, s.count ?? 1);
      case 'playlistPlay':
        return this.playlistPlay(run, s.playlist);
    }
  }

  // ------------------------------------------------------------------ the AI translator's steps

  /** Candidates as video ids; a real "newest / trending" lookup is noted on `opts`. */
  private async *ids(
    run: Run,
    find: Find,
    opts: { fresh?: 'latest' | 'popular' | null },
  ): AsyncGenerator<string> {
    for await (const c of this.finder.candidates(
      run.me.id,
      run.actor.roomId,
      find,
    )) {
      if (c.fresh) opts.fresh = c.fresh;
      yield c.externalId;
    }
  }

  /** "thêm 3 bài của J97", "thêm Lạc Trôi và Nàng Thơ", "vài bài chill". */
  private async findAndAdd(
    run: Run,
    find: Find,
    count: number,
    pin?: Pin,
  ): Promise<void> {
    const artist = (await this.finder.artistOf(find))?.name;
    if (find.titles?.length) {
      // Each named song on its own: one of each, that very song.
      for (const title of find.titles) {
        const opts: {
          pin?: Pin;
          query: string;
          exact: boolean;
          artist?: string;
          fresh?: 'latest' | 'popular' | null;
        } = { pin, query: title, exact: true, artist };
        await this.addSongs(
          run,
          this.ids(run, { ...find, titles: [title] }, opts),
          1,
          opts,
        );
      }
      return;
    }
    const opts: {
      pin?: Pin;
      query?: string;
      fresh?: 'latest' | 'popular' | null;
      artist?: string;
    } = { pin, query: artist ?? find.mood, artist };
    await this.addSongs(run, this.ids(run, find, opts), count, opts);
  }

  /** "gợi ý bài của J97": songs shown with an "add" button, nothing added. */
  private async suggest(run: Run, find: Find, count: number): Promise<void> {
    const want = Math.max(1, count || SUGGEST_DEFAULT);
    const artist = (await this.finder.artistOf(find))?.name;
    const queued = new Set(
      (await this.queueNow(run)).map((q) => q.track.externalId),
    );
    const ids: string[] = [];
    for await (const c of this.finder.candidates(
      run.me.id,
      run.actor.roomId,
      find,
    )) {
      if (queued.has(c.externalId)) continue;
      ids.push(c.externalId);
      // A few spare: some cannot be shown (not embeddable, gone).
      if (ids.length >= want + 2) break;
    }
    const tracks = ids.length
      ? (await this.library.lookup(ids)).tracks.slice(0, want)
      : [];
    run.steps.push(
      tracks.length
        ? { action: 'suggest', ok: true, tracks, ...(artist ? { artist } : {}) }
        : {
            action: 'suggest',
            ok: false,
            reason: 'notFound',
            ...this.asked(find, artist),
          },
    );
  }

  private asked(find: Find, artist?: string): { query?: string } {
    const q = find.titles?.join(', ') ?? artist ?? find.mood;
    return q ? { query: q.slice(0, 150) } : {};
  }

  /** The queue songs a target means (artists resolved on YouTube Music first). */
  private async targets(run: Run, target: Target) {
    const snap = await this.snapshots.build(run.actor.roomId);
    // "của Đen" when someone in the room is called Đen: the picker, not the artist (spec).
    const people = new Set(
      (snap?.members ?? [])
        .filter((m) => !m.isDevice)
        .map((m) => normalizeQuery(m.displayName)),
    );
    const person = (n?: string) => Boolean(n && people.has(normalizeQuery(n)));
    let t = target;
    if (person(t.artist)) t = { ...t, by: t.artist, artist: undefined };
    if (t.keep && person(t.keep.artist))
      t = {
        ...t,
        keep: { ...t.keep, member: t.keep.artist, artist: undefined },
      };
    const [artist, keep] = await Promise.all([
      t.artist ? this.resolver.artist(t.artist) : undefined,
      t.keep?.artist ? this.resolver.artist(t.keep.artist) : undefined,
    ]);
    return {
      ...selectTargets(snap?.queue ?? [], t, run.me, { artist, keep }),
      artist: artist?.name,
      keepArtist: keep?.name,
    };
  }

  /** "Đổi bài A thành B": A from the queue (the asker's, or any for the admin), B found. */
  private async replaceWith(run: Run, t: Target, find: Find): Promise<void> {
    const admin = run.me.role === 'ADMIN';
    // The AI cannot see the queue: A must be named (title or place), and exactly one song.
    const named = Boolean(t.titles?.length || t.positions?.length);
    const { items } = await this.targets(run, admin ? t : { ...t, mine: true });
    const from = named && items.length === 1 ? items[0] : undefined;
    if (!from) {
      run.steps.push({
        action: 'remove',
        ok: false,
        reason: 'notFound',
        ...this.said(t),
      });
      return;
    }
    // B first: A is only removed once its replacement is in hand.
    const ids: string[] = [];
    for await (const c of this.finder.candidates(
      run.me.id,
      run.actor.roomId,
      find,
    )) {
      ids.push(c.externalId);
      if (ids.length >= 1 + SPARE_TRIES) break;
    }
    if (!ids.length) {
      run.steps.push({
        action: 'add',
        ok: false,
        reason: 'notFound',
        ...this.asked(find),
      });
      return;
    }
    try {
      await this.queue.remove(run.actor, from.id);
      run.steps.push({
        action: 'remove',
        ok: true,
        queueItemId: from.id,
        track: from.track,
      });
    } catch (e) {
      run.steps.push({ ...failed('remove', e), track: from.track });
      return;
    }
    const artist = (await this.finder.artistOf(find))?.name;
    await this.addSongs(run, ids, 1, {
      query: find.titles?.[0] ?? artist,
      exact: Boolean(find.titles?.length),
      artist,
    });
  }

  /** "Lưu bài này": the song on air into the asker's saved songs. */
  private async save(run: Run): Promise<void> {
    const np = (await this.snapshots.build(run.actor.roomId))?.nowPlaying;
    if (!np) {
      run.steps.push({ action: 'save', ok: false, reason: 'nothingPlaying' });
      return;
    }
    try {
      await this.library.setFavorite(run.actor, np.item.track.id, true);
      run.steps.push({ action: 'save', ok: true, track: np.item.track });
    } catch (e) {
      run.steps.push({ ...failed('save', e), track: np.item.track });
    }
  }

  /** The Google account behind the asker: this socket's, else the member's. */
  private userOf(run: Run): string | null {
    return run.actor.userId ?? run.me.userId ?? null;
  }

  /** The asker's playlist by name; pushes the answer itself when there is none to use. */
  private async findPlaylist(
    run: Run,
    action: DjAction,
    userId: string,
    name: string,
  ): Promise<{ id: string; name: string } | null | 'none'> {
    const { one, several } = playlistNamed(
      await this.playlists.mine(userId),
      name,
      // "Tạo playlist X": only X itself, never a playlist whose name merely holds it.
      action === 'playlistCreate',
    );
    if (one) return one;
    if (several.length) {
      run.steps.push({
        action,
        ok: false,
        reason: 'noPlaylist',
        query: name,
        options: several.map((l) => l.name).slice(0, 8),
      });
      return null;
    }
    return 'none';
  }

  /** "Lưu bài này vào playlist X": X is made when the asker has none by that name. */
  private async playlistSave(run: Run, name: string): Promise<void> {
    const userId = this.userOf(run);
    if (!userId) {
      run.steps.push({
        action: 'playlistSave',
        ok: false,
        reason: 'needSignIn',
      });
      return;
    }
    const np = (await this.snapshots.build(run.actor.roomId))?.nowPlaying;
    if (!np) {
      run.steps.push({
        action: 'playlistSave',
        ok: false,
        reason: 'nothingPlaying',
      });
      return;
    }
    const track = np.item.track;
    try {
      const found = await this.findPlaylist(run, 'playlistSave', userId, name);
      if (found === null) return;
      if (found === 'none') {
        const id = await this.playlists.create(userId, name, [track.id]);
        run.steps.push({
          action: 'playlistSave',
          ok: true,
          track,
          playlist: { id, name, created: true },
        });
        return;
      }
      await this.playlists.setTrack(userId, found.id, track.id, true);
      run.steps.push({
        action: 'playlistSave',
        ok: true,
        track,
        playlist: { ...found, created: false },
      });
    } catch (e) {
      run.steps.push({ ...failed('playlistSave', e), track });
    }
  }

  /** "Tạo playlist X (gồm 5 bài của Đen)": songs go into the playlist, not the queue. */
  private async playlistCreate(
    run: Run,
    name: string,
    find: Find | undefined,
    count: number,
  ): Promise<void> {
    const userId = this.userOf(run);
    if (!userId) {
      run.steps.push({
        action: 'playlistCreate',
        ok: false,
        reason: 'needSignIn',
      });
      return;
    }
    try {
      let trackIds: string[] = [];
      if (find) {
        const ids: string[] = [];
        for await (const c of this.finder.candidates(
          run.me.id,
          run.actor.roomId,
          find,
        )) {
          ids.push(c.externalId);
          if (ids.length >= count + 2) break;
        }
        if (ids.length)
          trackIds = (await this.library.lookup(ids)).tracks
            .slice(0, count)
            .map((t) => t.id);
      }
      const found = await this.findPlaylist(
        run,
        'playlistCreate',
        userId,
        name,
      );
      if (found === null) return;
      const created = found === 'none';
      const id = created
        ? await this.playlists.create(userId, name, trackIds)
        : found.id;
      if (!created)
        for (const t of trackIds)
          await this.playlists.setTrack(userId, id, t, true);
      run.steps.push({
        action: 'playlistCreate',
        ok: true,
        playlist: { id, name: created ? name : found.name, created },
        added: trackIds.length,
        ...(find ? { total: count } : {}),
        ...(find?.artist
          ? { artist: (await this.finder.artistOf(find))?.name }
          : {}),
      });
    } catch (e) {
      run.steps.push(failed('playlistCreate', e));
    }
  }

  /** "Phát playlist X": its songs into the queue, in order, as far as the asker's limit allows. */
  private async playlistPlay(run: Run, name: string): Promise<void> {
    const userId = this.userOf(run);
    if (!userId) {
      run.steps.push({
        action: 'playlistPlay',
        ok: false,
        reason: 'needSignIn',
      });
      return;
    }
    try {
      const found = await this.findPlaylist(run, 'playlistPlay', userId, name);
      if (found === null) return;
      if (found === 'none') {
        run.steps.push({
          action: 'playlistPlay',
          ok: false,
          reason: 'noPlaylist',
          query: name,
        });
        return;
      }
      const list = await this.playlists.get(userId, { id: found.id });
      const ids = list.tracks.map((t) => t.id).slice(0, ADD_MANY_MAX);
      if (!ids.length) {
        run.steps.push({
          action: 'playlistPlay',
          ok: false,
          reason: 'notFound',
          playlist: { ...found, created: false },
        });
        return;
      }
      const r = await this.queue.addMany(run.actor, ids);
      // Why it stopped: the queue limit first (it needs its number), else the first reason.
      const why =
        r.skipped.find((x) => x.reason === 'QUEUE_LIMIT') ?? r.skipped[0];
      const max = (await this.snapshots.build(run.actor.roomId))?.room.settings
        .maxQueuedPerMember;
      run.steps.push({
        action: 'playlistPlay',
        ok: r.added > 0,
        playlist: { ...found, created: false },
        added: r.added,
        total: list.tracks.length,
        ...(r.added === 0 && why
          ? {
              errorCode: why.reason,
              ...(why.reason === 'QUEUE_LIMIT' && max
                ? { errorParams: { max } }
                : {}),
            }
          : {}),
      });
    } catch (e) {
      run.steps.push(failed('playlistPlay', e));
    }
  }

  // ------------------------------------------------------------------ adding

  /** Lazily: the next pick is looked up only when the previous one could not go in. */
  private async *pickIds(
    run: Run,
    picks: { artist: string; song: string }[],
  ): AsyncGenerator<string> {
    for (const p of picks) {
      const known = await this.dj.findKnown(p.artist, p.song);
      if (known) {
        yield known.externalId;
        continue;
      }
      const { results } = await this.search.search(
        run.me.id,
        `${p.artist} ${p.song}`,
      );
      if (results[0]) yield results[0].externalId;
    }
  }

  /** Adds up to `count` of the candidates, as the asker; reports each song (or why none). */
  private async addSongs(
    run: Run,
    ids: Iterable<string> | AsyncIterable<string>,
    count: number,
    opts: {
      pin?: Pin;
      query?: string;
      fresh?: 'latest' | 'popular' | null;
      /** Asked for by name (see TRY_NEXT_EXACT). */
      exact?: boolean;
      /** The artist as understood (YouTube Music's name), for the answer. */
      artist?: string;
    },
  ): Promise<void> {
    if (run.full) return;
    let added = 0;
    let tries = 0;
    for await (const id of ids) {
      if (added >= count || ++tries > count + SPARE_TRIES) break;
      const wish = run.wish;
      try {
        const { queueItemId } = await this.queue.add(run.actor, {
          input: `https://www.youtube.com/watch?v=${id}`,
          ...(wish ? { wishMessage: wish } : {}),
        });
        if (wish) run.wish = undefined;
        added++;
        const step = await this.placed(run, queueItemId);
        run.steps.push({
          ...step,
          ...(wish ? { wish } : {}),
          fresh: opts.fresh ?? null,
          ...(opts.artist ? { artist: opts.artist } : {}),
        });
        if (opts.pin && added === 1 && step.position !== 0)
          await this.pin(run, queueItemId, step, opts.pin === 'now');
      } catch (e) {
        const next = opts.exact ? TRY_NEXT_EXACT : TRY_NEXT;
        if (e instanceof AppError && next.includes(e.code)) continue;
        run.steps.push({
          ...failed('add', e),
          ...(opts.query ? { query: opts.query } : {}),
        });
        if (e instanceof AppError && STOP_ADDING.includes(e.code))
          run.full = true;
        return;
      }
    }
    if (added < count)
      run.steps.push({
        action: 'add',
        ok: false,
        reason: 'notFound',
        ...(opts.query ? { query: opts.query } : {}),
        ...(opts.artist ? { artist: opts.artist } : {}),
        // "2 bài chill" but only one could go in.
        ...(added ? { got: added, wanted: count } : {}),
      });
  }

  /** Where the song went: on air at once (idle room, position 0) or its place in the queue. */
  private async placed(run: Run, queueItemId: string): Promise<DjStep> {
    const snap = await this.snapshots.build(run.actor.roomId);
    if (snap?.nowPlaying?.item.id === queueItemId)
      return {
        action: 'add',
        ok: true,
        queueItemId,
        track: snap.nowPlaying.item.track,
        position: 0,
        etaSec: 0,
      };
    const at = snap?.queue.findIndex((q) => q.id === queueItemId) ?? -1;
    return {
      action: 'add',
      ok: true,
      queueItemId,
      ...(at >= 0 ? { track: snap!.queue[at].track } : {}),
      position: at >= 0 ? at + 1 : undefined,
      etaSec: snap && at >= 0 ? etaSec(snap, at) : null,
    };
  }

  /** "Ngay sau bài này" (pin next) / "luôn" (pin next and skip to it): control rights. */
  private async pin(
    run: Run,
    queueItemId: string,
    added: DjStep,
    now: boolean,
  ): Promise<void> {
    try {
      const queue = await this.queueNow(run);
      const at = queue.findIndex((q) => q.id === queueItemId);
      // Pinned songs play in the order they were pinned: to play this one now, the ones pinned
      // before it step back behind it (unpinned, then pinned again: still next after it).
      const ahead = now
        ? queue.slice(0, Math.max(0, at)).filter((q) => q.pinned)
        : [];
      for (const q of ahead) await this.queue.pinNext(run.actor, q.id);
      // pinNext toggles: a song pinned already stays pinned.
      if (!queue[at]?.pinned) await this.queue.pinNext(run.actor, queueItemId);
      if (ahead.length) {
        // A later pin time than this song's, so they stay behind it.
        await new Promise((r) => setTimeout(r, 2));
        for (const q of ahead) await this.queue.pinNext(run.actor, q.id);
      }
      if (now) {
        const snap = await this.snapshots.build(run.actor.roomId);
        const np = snap?.nowPlaying;
        if (np)
          await this.playback.control(run.actor, {
            action: 'skip',
            queueItemId: np.item.id,
          });
      }
      run.steps.push({
        action: 'pin',
        ok: true,
        queueItemId,
        ...(added.track ? { track: added.track } : {}),
        now,
      });
    } catch (e) {
      run.steps.push({
        ...failed('pin', e),
        ...(added.track ? { track: added.track } : {}),
        now,
      });
    }
  }

  // ------------------------------------------------------------------ the queue

  private async queueNow(run: Run): Promise<QueueItemView[]> {
    return (await this.snapshots.build(run.actor.roomId))?.queue ?? [];
  }

  /** What was asked for, when nothing in the queue matches it. */
  private said(t: Target): { query?: string } {
    const q = t.said ?? t.titles?.join(', ');
    return q ? { query: q.slice(0, 150) } : {};
  }

  /** One heart per member in this room (QueueService.heart moves it): the first match gets it. */
  private async heart(run: Run, t: Target): Promise<void> {
    const { items: matched } = await this.targets(run, t);
    // The picker cannot heart their own songs (QueueService.heart refuses: OWN_SONG).
    const items = matched.filter((q) => q.addedBy?.id !== run.me.id);
    const first = items[0];
    if (!first) {
      run.steps.push(
        matched[0]
          ? {
              action: 'heart',
              ok: false,
              reason: 'ownSong',
              track: matched[0].track,
            }
          : {
              action: 'heart',
              ok: false,
              reason: 'notFound',
              ...this.said(t),
            },
      );
      return;
    }
    const base = {
      action: 'heart' as const,
      queueItemId: first.id,
      track: first.track,
    };
    // Hearting again would take the heart back.
    if (first.heartedBy.includes(run.me.id)) {
      run.steps.push({ ...base, ok: true, reason: 'alreadyHearted' });
      return;
    }
    try {
      await this.queue.heart(run.actor, first.id);
      run.steps.push({
        ...base,
        ok: true,
        ...(items.length > 1 || t.all || t.by || t.mine || t.others || t.artist
          ? { reason: 'oneHeart' as const }
          : {}),
      });
    } catch (e) {
      run.steps.push({ ...failed('heart', e), track: first.track });
    }
  }

  private async remove(run: Run, t: Target): Promise<void> {
    const { items, kept, unsure, artist, keepArtist } = await this.targets(
      run,
      t,
    );
    // "Trừ / chừa …": what was kept is part of the answer, removed or not.
    const keptStep = (): void => {
      if (kept.length)
        run.steps.push({
          action: 'remove',
          ok: true,
          reason: 'kept',
          tracks: kept.map((q) => q.track),
          ...(unsure ? { unsure } : {}),
          ...(keepArtist ? { artist: keepArtist } : {}),
        });
    };
    if (!items.length) {
      if (kept.length) return keptStep();
      run.steps.push({
        action: 'remove',
        ok: false,
        reason: 'notFound',
        ...this.said(t),
        ...(artist ? { artist } : {}),
      });
      return;
    }
    const admin = run.me.role === 'ADMIN';
    const others = items.filter((q) => q.addedBy?.id !== run.me.id && !admin);
    for (const q of items) {
      if (others.includes(q)) continue;
      try {
        await this.queue.remove(run.actor, q.id);
        run.steps.push({
          action: 'remove',
          ok: true,
          queueItemId: q.id,
          track: q.track,
        });
      } catch (e) {
        run.steps.push({ ...failed('remove', e), track: q.track });
      }
    }
    // Other people's songs: only the admin removes them.
    if (others.length)
      run.steps.push({
        action: 'remove',
        ok: false,
        reason: 'notMine',
        ...(others.length === 1 ? { track: others[0].track } : {}),
      });
    keptStep();
  }

  /** "Đổi bài X của tôi thành Y" (the old rules): the same checks as the translator's. */
  private replace(run: Run, from: string, to: string): Promise<void> {
    return this.replaceWith(run, { titles: [from] }, { titles: [to] });
  }

  /**
   * "Ghim bài số 3" (next) / "skip đến bài cuối", "chuyển sang Lạc Trôi" (now): control rights.
   * A song asked for by name that is not queued yet is added there instead.
   */
  private async pinTarget(run: Run, t: Target, now: boolean): Promise<void> {
    const item = (await this.targets(run, t)).items[0];
    if (item) {
      const step: DjStep = {
        action: 'pin',
        ok: true,
        queueItemId: item.id,
        track: item.track,
      };
      return this.pin(run, item.id, step, now);
    }
    const title =
      t.titles?.length === 1 && !t.by && !t.mine ? t.titles[0] : null;
    if (title)
      return this.findAndAdd(
        run,
        { titles: [title], ...(t.artist ? { artist: t.artist } : {}) },
        1,
        now ? 'now' : 'next',
      );
    run.steps.push({
      action: 'pin',
      ok: false,
      reason: 'notFound',
      ...this.said(t),
    });
  }

  // ------------------------------------------------------------------ playback

  /** Control rights skip at once; everyone else votes. false = no further skip makes sense. */
  private async skip(run: Run): Promise<boolean> {
    const np = (await this.snapshots.build(run.actor.roomId))?.nowPlaying;
    if (!np) {
      run.steps.push({ action: 'skip', ok: false, reason: 'nothingPlaying' });
      return false;
    }
    const control = run.me.role === 'ADMIN' || run.me.canControl;
    const action = control ? 'skip' : 'vote';
    try {
      if (control)
        await this.playback.control(run.actor, {
          action: 'skip',
          queueItemId: np.item.id,
        });
      else await this.playback.voteSkip(run.actor, np.item.id);
      run.steps.push({ action, ok: true, track: np.item.track });
      // A vote is one per song: "bỏ qua 3 bài" votes on the song on air only.
      return control;
    } catch (e) {
      run.steps.push({ ...failed(action, e), track: np.item.track });
      return false;
    }
  }

  private async control(run: Run, what: 'pause' | 'resume'): Promise<void> {
    const np = (await this.snapshots.build(run.actor.roomId))?.nowPlaying;
    if (!np) {
      run.steps.push({ action: what, ok: false, reason: 'nothingPlaying' });
      return;
    }
    try {
      await this.playback.control(run.actor, {
        action: what === 'pause' ? 'pause' : 'play',
        queueItemId: np.item.id,
      });
      run.steps.push({ action: what, ok: true, track: np.item.track });
    } catch (e) {
      run.steps.push({ ...failed(what, e), track: np.item.track });
    }
  }
}
