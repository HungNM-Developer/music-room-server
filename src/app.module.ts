import { type DynamicModule, Module } from '@nestjs/common';
import { AuthService } from './auth/auth.service';
import { DEFAULT_TIMING, TIMING, type Timing } from './common/timing';
import { ENV, type Env } from './config/env';
import { HealthController } from './health/health.controller';
import { LibraryService } from './library/library.service';
import { YouTubeAccountService } from './music/youtube-account.service';
import { PlaylistsService } from './playlists/playlists.service';
import { TasteService } from './taste/taste.service';
import { UsersService } from './users/users.service';
import { AiService } from './ai/ai.service';
import { DjService } from './ai/dj.service';
import { DjBrainService } from './dj/dj-brain.service';
import { DjComboService } from './dj/dj-combo.service';
import { DjFinder } from './dj/dj-find';
import { DjResolver } from './dj/dj-resolve';
import { McService } from './ai/mc.service';
import { ModerationService } from './ai/moderation.service';
import { LastFmService } from './music/lastfm.service';
import { LyricsService } from './music/lyrics.service';
import { SuggestService } from './music/suggest.service';
import { TrackMetaService } from './music/track-meta.service';
import { MembersService } from './members/members.service';
import { ApiDataRetentionService } from './music/api-data-retention.service';
import { PlaylistService } from './music/playlist.service';
import { SearchService } from './music/search.service';
import { SongListService } from './music/songlist.service';
import { ChatNotifierService } from './chat/chat-notifier.service';
import { ChatRoomService } from './chat/chat-room.service';
import { SlackApi } from './chat/slack/slack-api.service';
import { SlackCommands } from './chat/slack/slack-commands.service';
import { SlackHomeService } from './chat/slack/slack-home.service';
import { SlackController } from './chat/slack/slack.controller';
import { TrackCacheService } from './music/track-cache.service';
import { InnerTubeProvider } from './music/innertube.provider';
import { YouTubeProvider } from './music/youtube.provider';
import { LeaseService } from './playback/lease.service';
import { PlaybackService } from './playback/playback.service';
import { PrismaService } from './prisma/prisma.service';
import { BlockService } from './queue/block.service';
import { RoomActivityService } from './rooms/room-activity.service';
import { RoomDeletionService } from './rooms/room-deletion.service';
import { QueueService } from './queue/queue.service';
import { Broadcaster } from './realtime/broadcaster.service';
import { PresenceService } from './realtime/presence.service';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { RoomsController } from './rooms/rooms.controller';
import { ActivityService } from './social/activity.service';
import { SocialService } from './social/social.service';
import { RoomStateService } from './state/room-state.service';
import { SnapshotService } from './state/snapshot.service';

import { WishWriterService } from './ai/wish-writer.service';
import { TtsController } from './tts/tts.controller';
import { TtsService } from './tts/tts.service';

@Module({})
export class AppModule {
  static forRoot(env: Env, timing: Timing = DEFAULT_TIMING): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        RoomsController,
        SlackController,
        TtsController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        { provide: TIMING, useValue: timing },
        PrismaService,
        AuthService,
        PresenceService,
        Broadcaster,
        LeaseService,
        SnapshotService,
        RoomStateService,
        ActivityService,
        YouTubeProvider,
        InnerTubeProvider,
        TrackCacheService,
        AiService,
        ModerationService,
        McService,
        TtsService,
        DjService,
        DjBrainService,
        DjComboService,
        DjResolver,
        DjFinder,
        WishWriterService,
        LastFmService,
        TrackMetaService,
        SuggestService,
        LyricsService,
        SearchService,
        SongListService,
        ChatRoomService,
        ChatNotifierService,
        SlackApi,
        SlackCommands,
        SlackHomeService,
        ApiDataRetentionService,
        PlaylistService,
        PlaybackService,
        QueueService,
        BlockService,
        RoomActivityService,
        RoomDeletionService,
        MembersService,
        SocialService,
        LibraryService,
        UsersService,
        PlaylistsService,
        YouTubeAccountService,
        TasteService,
        RealtimeGateway,
      ],
    };
  }
}
