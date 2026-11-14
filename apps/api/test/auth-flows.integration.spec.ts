import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { LoginRateLimiterService } from '../src/auth/login-rate-limiter.service';
import { PasswordService } from '../src/auth/password.service';
import { TokenService } from '../src/auth/token.service';
import { TotpService } from '../src/auth/totp.service';
import { validateEnv, type AppEnv } from '../src/config/env.schema';
import { DatabaseService } from '../src/database/database.module';
import { runSqlMigrations } from '../src/database/migrate';
import { EmailService } from '../src/email/email.service';
import { RedisService } from '../src/redis/redis.module';

describe('AuthService Flows (Sign Up, Verify Email, Login, Refresh Rotation, TOTP 2FA)', () => {
  let dbService: DatabaseService;
  let redisService: RedisService;
  let emailService: EmailService;
  let totpService: TotpService;
  let tokenService: TokenService;
  let authService: AuthService;

  const meta = { ipAddress: '127.0.0.1', userAgent: 'Vitest-Agent/1.0' };

  beforeAll(async () => {
    const env = validateEnv({
      NODE_ENV: 'test',
      DATABASE_ADMIN_URL:
        process.env.DATABASE_ADMIN_URL ??
        'postgresql://teamloom_admin:teamloom_admin_local_pw@localhost:5432/teamloom_dev',
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://teamloom_app:teamloom_app_local_pw@localhost:5432/teamloom_dev',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    });

    await runSqlMigrations(env.DATABASE_ADMIN_URL);

    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
    dbService = new DatabaseService(pool);

    const redisClient = new Redis(env.REDIS_URL);
    redisService = new RedisService(redisClient);

    const configService = new ConfigService<AppEnv, true>(env);
    const passwordService = new PasswordService();
    await passwordService.onModuleInit();

    tokenService = new TokenService(new JwtService(), configService);
    const rateLimiter = new LoginRateLimiterService(redisService);
    emailService = new EmailService(configService);
    totpService = new TotpService(configService);

    authService = new AuthService(
      dbService,
      passwordService,
      tokenService,
      rateLimiter,
      emailService,
      totpService,
    );
  });

  afterAll(async () => {
    await dbService.onModuleDestroy();
    await redisService.onModuleDestroy();
  });

  it('completes sign up -> single-use email verification -> login -> password reset flow', async () => {
    const uniqueEmail = `founder_${Date.now()}@teamloom.io`;

    const signUpRes = await authService.signUp(
      {
        email: uniqueEmail,
        password: 'InitialPassword123',
        fullName: 'Piyush Ratn',
      },
      meta,
    );

    expect(signUpRes.user.email).toBe(uniqueEmail);
    expect(signUpRes.user.emailVerifiedAt).toBeNull();

    const verifyMail = emailService.testOutbox.find(
      (m) => m.to === uniqueEmail && m.subject.includes('Verify'),
    );
    expect(verifyMail?.token).toBeDefined();

    const verifyRes = await authService.verifyEmail({
      token: verifyMail!.token!,
    });
    expect(verifyRes.verified).toBe(true);

    await expect(
      authService.verifyEmail({ token: verifyMail!.token! }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const loginRes = await authService.login(
      {
        email: uniqueEmail,
        password: 'InitialPassword123',
      },
      meta,
    );
    expect(loginRes.user.emailVerifiedAt).not.toBeNull();

    await authService.forgotPassword({ email: uniqueEmail });
    const resetMail = emailService.testOutbox.find(
      (m) => m.to === uniqueEmail && m.subject.includes('Reset'),
    );
    expect(resetMail?.token).toBeDefined();

    await authService.resetPassword({
      token: resetMail!.token!,
      newPassword: 'UpdatedPassword456',
    });

    await expect(
      authService.login(
        { email: uniqueEmail, password: 'InitialPassword123' },
        meta,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const postResetLogin = await authService.login(
      { email: uniqueEmail, password: 'UpdatedPassword456' },
      meta,
    );
    expect(postResetLogin.accessToken).toBeDefined();
  });

  it('rotates refresh tokens and revokes the entire token family if a rotated token is reused', async () => {
    const uniqueEmail = `rotation_${Date.now()}@teamloom.io`;

    const initial = await authService.signUp(
      {
        email: uniqueEmail,
        password: 'StrongPassword123',
        fullName: 'Rotation Tester',
      },
      meta,
    );

    // Legitimate rotation 1: token1 -> token2
    const rotated = await authService.refreshTokens(
      { refreshToken: initial.refreshToken },
      meta,
    );
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);

    // Attacker (or replay) tries to use token1 again -> triggers family revocation!
    await expect(
      authService.refreshTokens({ refreshToken: initial.refreshToken }, meta),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Now even token2 (the latest token in that family) must be rejected because the family was compromised
    await expect(
      authService.refreshTokens({ refreshToken: rotated.refreshToken }, meta),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('enforces TOTP 2FA and single-use recovery codes when enabled, and manages active sessions', async () => {
    const uniqueEmail = `totp_${Date.now()}@teamloom.io`;

    const signUpRes = await authService.signUp(
      {
        email: uniqueEmail,
        password: 'StrongPassword123',
        fullName: 'TOTP Tester',
      },
      meta,
    );

    const userId = signUpRes.user.id;
    const { secret } = await authService.initiateTotpSetup(userId);
    const validCode = totpService.generateCode(secret);

    const { enabled, recoveryCodes } = await authService.confirmTotpSetup(
      userId,
      validCode,
    );
    expect(enabled).toBe(true);
    expect(recoveryCodes.length).toBe(8);

    // Login without totpCode must now fail with 401
    await expect(
      authService.login(
        { email: uniqueEmail, password: 'StrongPassword123' },
        meta,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Login with valid TOTP code succeeds
    const totpLogin = await authService.login(
      {
        email: uniqueEmail,
        password: 'StrongPassword123',
        totpCode: totpService.generateCode(secret),
      },
      meta,
    );
    expect(totpLogin.user.totpEnabled).toBe(true);

    // Login with a single-use recovery code succeeds once, then fails if reused
    const firstRecoveryCode = recoveryCodes[0]!;
    const recoveryLogin = await authService.login(
      {
        email: uniqueEmail,
        password: 'StrongPassword123',
        totpCode: firstRecoveryCode,
      },
      meta,
    );
    expect(recoveryLogin.accessToken).toBeDefined();

    await expect(
      authService.login(
        {
          email: uniqueEmail,
          password: 'StrongPassword123',
          totpCode: firstRecoveryCode,
        },
        meta,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Active sessions list and logoutAllDevices
    const decoded = await tokenService.verifyAccessToken(
      recoveryLogin.accessToken,
    );
    const activeSessions = await authService.listActiveSessions(
      userId,
      decoded.sessionId,
    );
    expect(activeSessions.length).toBeGreaterThanOrEqual(2);
    expect(activeSessions.some((s) => s.isCurrent)).toBe(true);

    await authService.logoutAllDevices(userId);
    const afterLogoutAll = await authService.listActiveSessions(
      userId,
      decoded.sessionId,
    );
    expect(afterLogoutAll.length).toBe(0);
  });
});