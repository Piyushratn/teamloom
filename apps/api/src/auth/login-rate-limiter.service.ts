import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.module';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_SECONDS = 15 * 60; // 15 minutes

@Injectable()
export class LoginRateLimiterService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  private getKey(email: string, ipAddress: string): string {
    return `auth:login_attempts:${email.toLowerCase()}:${ipAddress}`;
  }

  async assertNotLockedOut(email: string, ipAddress: string): Promise<void> {
    const key = this.getKey(email, ipAddress);
    const rawCount = await this.redis.client.get(key);
    const attempts = rawCount ? Number.parseInt(rawCount, 10) : 0;

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const ttl = await this.redis.client.ttl(key);
      throw new HttpException(
        {
          errorCode: 'ACCOUNT_TEMPORARILY_LOCKED',
          message: `Too many failed login attempts. Please try again in ${Math.max(ttl, 1)} seconds.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async recordFailedAttempt(email: string, ipAddress: string): Promise<number> {
    const key = this.getKey(email, ipAddress);
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, LOCKOUT_WINDOW_SECONDS);
    }
    return count;
  }

  async clearAttempts(email: string, ipAddress: string): Promise<void> {
    const key = this.getKey(email, ipAddress);
    await this.redis.client.del(key);
  }
}