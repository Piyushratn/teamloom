import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoginRateLimiterService } from '../src/auth/login-rate-limiter.service';
import { PasswordService } from '../src/auth/password.service';
import { TokenService } from '../src/auth/token.service';
import { validateEnv, type AppEnv } from '../src/config/env.schema';
import { RedisService } from '../src/redis/redis.module';

describe('Auth Crypto & Redis Login Rate-Limiter', () => {
  let passwordService: PasswordService;
  let tokenService: TokenService;
  let rateLimiter: LoginRateLimiterService;
  let redisService: RedisService;

  beforeAll(async () => {
    passwordService = new PasswordService();
    await passwordService.onModuleInit();

    const env = validateEnv({
      DATABASE_ADMIN_URL:
        process.env.DATABASE_ADMIN_URL ??
        'postgresql://teamloom_admin:teamloom_admin_local_pw@localhost:5432/teamloom_dev',
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://teamloom_app:teamloom_app_local_pw@localhost:5432/teamloom_dev',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    });

    const configService = new ConfigService<AppEnv, true>(env);
    tokenService = new TokenService(new JwtService(), configService);

    const redisClient = new Redis(env.REDIS_URL);
    redisService = new RedisService(redisClient);
    rateLimiter = new LoginRateLimiterService(redisService);
  });

  afterAll(async () => {
    await redisService.onModuleDestroy();
  });

  it('hashes and verifies passwords with argon2id', async () => {
    const hash = await passwordService.hash('CorrectHorseBatteryStaple1');
    expect(hash.startsWith('$argon2id$')).toBe(true);

    expect(
      await passwordService.verify(hash, 'CorrectHorseBatteryStaple1'),
    ).toBe(true);
    expect(await passwordService.verify(hash, 'WrongPassword1')).toBe(false);
  });

  it('signs and verifies JWT access tokens and hashes opaque tokens deterministically', async () => {
    const jwt = await tokenService.signAccessToken({
      sub: '11111111-2222-3333-4444-555555555555',
      email: 'piyush@teamloom.io',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    const payload = await tokenService.verifyAccessToken(jwt);
    expect(payload.email).toBe('piyush@teamloom.io');

    const { rawToken, tokenHash } = tokenService.generateOpaqueToken();
    expect(rawToken.length).toBeGreaterThanOrEqual(40);
    expect(tokenService.hashToken(rawToken)).toBe(tokenHash);
  });

  it('locks out login after 5 failed attempts and resets on clearAttempts', async () => {
    const email = `ratelimit_${Date.now()}@teamloom.io`;
    const ip = '127.0.0.1';

    await rateLimiter.clearAttempts(email, ip);
    for (let i = 0; i < 5; i++) {
      await rateLimiter.recordFailedAttempt(email, ip);
    }

    let lockedError: unknown;
    try {
      await rateLimiter.assertNotLockedOut(email, ip);
    } catch (err) {
      lockedError = err;
    }

    expect(lockedError).toBeInstanceOf(HttpException);
    expect((lockedError as HttpException).getStatus()).toBe(429);

    await rateLimiter.clearAttempts(email, ip);
    await expect(
      rateLimiter.assertNotLockedOut(email, ip),
    ).resolves.toBeUndefined();
  });
});