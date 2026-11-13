import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { HealthStatusSchema, type HealthStatus } from '@teamloom/contracts';
import { DatabaseService } from '../database/database.module';
import { RedisService } from '../redis/redis.module';

interface FastifyReplyLike {
  status(code: number): FastifyReplyLike;
  send(payload: unknown): void;
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Get()
  async check(@Res() reply: FastifyReplyLike): Promise<void> {
    const [dbUp, redisUp] = await Promise.all([
      this.db.ping(),
      this.redis.ping(),
    ]);

    const allUp = dbUp && redisUp;
    const allDown = !dbUp && !redisUp;

    const payload: HealthStatus = HealthStatusSchema.parse({
      status: allUp ? 'ok' : allDown ? 'down' : 'degraded',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      services: {
        database: dbUp ? 'up' : 'down',
        redis: redisUp ? 'up' : 'down',
      },
    });

    const httpStatus = allUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    reply.status(httpStatus).send(payload);
  }
}