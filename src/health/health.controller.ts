import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ENV, type Env } from '../config/env';
import { CONTRACTS_VERSION } from '../contracts';
import { YouTubeProvider } from '../music/youtube.provider';
import { PrismaService } from '../prisma/prisma.service';
import { TtsService } from '../tts/tts.service';

/** R-45: 200 when the database answers, 503 otherwise. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly youtube: YouTubeProvider,
    private readonly tts: TtsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  async health(@Res() res: Response): Promise<void> {
    let db: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    res
      .status(db === 'up' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        status: db === 'up' ? 'ok' : 'degraded',
        db,
        contractsVersion: CONTRACTS_VERSION,
        searchEnabled: this.youtube.searchEnabled,
        // L1: public OAuth client id, so the web app needs no separate setting.
        googleClientId: this.env.GOOGLE_CLIENT_ID ?? null,
        // Edge voices for wishes / MC lines: ready or why not, and how recent lines went.
        tts: this.tts.status(),
      });
  }
}
