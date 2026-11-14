import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  ActiveSession,
  AuthTokensResponse,
  AuthUser,
  ForgotPasswordRequest,
  LoginRequest,
  RefreshTokenRequest,
  ResetPasswordRequest,
  SignUpRequest,
  VerifyEmailRequest,
} from '@teamloom/contracts';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.module';
import { authSessions, users, verificationTokens } from '../database/schema';
import { EmailService } from '../email/email.service';
import { LoginRateLimiterService } from './login-rate-limiter.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';

export interface RequestMetadata {
  ipAddress: string;
  userAgent: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
    @Inject(PasswordService) private readonly passwordService: PasswordService,
    @Inject(TokenService) private readonly tokenService: TokenService,
    @Inject(LoginRateLimiterService)
    private readonly rateLimiter: LoginRateLimiterService,
    @Inject(EmailService) private readonly emailService: EmailService,
    @Inject(TotpService) private readonly totpService: TotpService,
  ) {}

  async signUp(
    input: SignUpRequest,
    meta: RequestMetadata,
  ): Promise<AuthTokensResponse> {
    const email = input.email.toLowerCase();
    const existing = await this.dbService.db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existing) {
      await this.passwordService.verifyDummy(input.password);
      throw new BadRequestException({
        errorCode: 'SIGNUP_FAILED',
        message: 'Unable to create account with the provided details',
      });
    }

    const passwordHash = await this.passwordService.hash(input.password);

    const [createdUser] = await this.dbService.db
      .insert(users)
      .values({
        email,
        passwordHash,
        fullName: input.fullName,
      })
      .returning();

    if (!createdUser) {
      throw new Error('Failed to insert user record');
    }

    const { rawToken, tokenHash } = this.tokenService.generateOpaqueToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.dbService.db.insert(verificationTokens).values({
      userId: createdUser.id,
      purpose: 'email_verification',
      tokenHash,
      expiresAt,
    });

    await this.emailService.sendVerificationEmail(
      createdUser.email,
      createdUser.fullName,
      rawToken,
    );

    const result = await this.createSessionAndIssueTokens(createdUser, meta);
    return result.response;
  }

  async verifyEmail(input: VerifyEmailRequest): Promise<{ verified: true }> {
    const tokenHash = this.tokenService.hashToken(input.token);

    const tokenRecord =
      await this.dbService.db.query.verificationTokens.findFirst({
        where: and(
          eq(verificationTokens.tokenHash, tokenHash),
          eq(verificationTokens.purpose, 'email_verification'),
        ),
      });

    if (
      !tokenRecord ||
      tokenRecord.usedAt !== null ||
      tokenRecord.expiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException({
        errorCode: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'Verification token is invalid or has expired',
      });
    }

    const now = new Date();
    await this.dbService.db
      .update(verificationTokens)
      .set({ usedAt: now })
      .where(eq(verificationTokens.id, tokenRecord.id));

    await this.dbService.db
      .update(users)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(eq(users.id, tokenRecord.userId));

    return { verified: true };
  }

  async login(
    input: LoginRequest,
    meta: RequestMetadata,
  ): Promise<AuthTokensResponse> {
    const email = input.email.toLowerCase();
    await this.rateLimiter.assertNotLockedOut(email, meta.ipAddress);

    const user = await this.dbService.db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) {
      await this.passwordService.verifyDummy(input.password);
      await this.rateLimiter.recordFailedAttempt(email, meta.ipAddress);
      throw new UnauthorizedException({
        errorCode: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    const passwordValid = await this.passwordService.verify(
      user.passwordHash,
      input.password,
    );

    if (!passwordValid) {
      await this.rateLimiter.recordFailedAttempt(email, meta.ipAddress);
      throw new UnauthorizedException({
        errorCode: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    if (user.totpEnabled && user.totpSecretEncrypted) {
      if (!input.totpCode) {
        throw new UnauthorizedException({
          errorCode: 'TOTP_REQUIRED',
          message: 'Two-factor authentication code is required',
        });
      }

      const secret = this.totpService.decryptSecret(user.totpSecretEncrypted);
      const isValidTotp = this.totpService.verifyCode(secret, input.totpCode);

      if (!isValidTotp) {
        const candidateHash = this.totpService.hashRecoveryCode(input.totpCode);
        const recoveryHashes = user.totpRecoveryCodesHashes ?? [];
        const matchIndex = recoveryHashes.indexOf(candidateHash);

        if (matchIndex === -1) {
          await this.rateLimiter.recordFailedAttempt(email, meta.ipAddress);
          throw new UnauthorizedException({
            errorCode: 'INVALID_TOTP_CODE',
            message: 'Invalid two-factor authentication or recovery code',
          });
        }

        const updatedHashes = recoveryHashes.filter((_, idx) => idx !== matchIndex);
        await this.dbService.db
          .update(users)
          .set({ totpRecoveryCodesHashes: updatedHashes, updatedAt: new Date() })
          .where(eq(users.id, user.id));
      }
    }

    await this.rateLimiter.clearAttempts(email, meta.ipAddress);
    const result = await this.createSessionAndIssueTokens(user, meta);
    return result.response;
  }

  /**
   * Rotates a refresh token. If an already-revoked token is replayed,
   * revokes the ENTIRE token family immediately (reuse detection).
   */
  async refreshTokens(
    input: RefreshTokenRequest,
    meta: RequestMetadata,
  ): Promise<AuthTokensResponse> {
    const tokenHash = this.tokenService.hashToken(input.refreshToken);

    const existingSession =
      await this.dbService.db.query.authSessions.findFirst({
        where: eq(authSessions.refreshTokenHash, tokenHash),
      });

    if (!existingSession) {
      throw new UnauthorizedException({
        errorCode: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token is invalid or expired',
      });
    }

    const now = new Date();

    // REUSE DETECTION: If this session was already rotated or revoked, nuke the entire family!
    if (existingSession.revokedAt !== null) {
      await this.dbService.db
        .update(authSessions)
        .set({
          revokedAt: now,
          revokeReason: 'refresh_token_reuse_detected',
        })
        .where(
          and(
            eq(authSessions.familyId, existingSession.familyId),
            isNull(authSessions.revokedAt),
          ),
        );

      throw new UnauthorizedException({
        errorCode: 'REFRESH_TOKEN_REUSE_DETECTED',
        message: 'Security alert: refresh token reuse detected. All sessions in this family have been revoked.',
      });
    }

    if (existingSession.expiresAt.getTime() < now.getTime()) {
      await this.dbService.db
        .update(authSessions)
        .set({ revokedAt: now, revokeReason: 'expired' })
        .where(eq(authSessions.id, existingSession.id));

      throw new UnauthorizedException({
        errorCode: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired',
      });
    }

    const user = await this.dbService.db.query.users.findFirst({
      where: eq(users.id, existingSession.userId),
    });

    if (!user) {
      throw new UnauthorizedException({
        errorCode: 'USER_NOT_FOUND',
        message: 'User account no longer exists',
      });
    }

    const { session: newSession, response } =
      await this.createSessionAndIssueTokens(
        user,
        meta,
        existingSession.familyId,
      );

    await this.dbService.db
      .update(authSessions)
      .set({
        revokedAt: now,
        revokeReason: 'rotated',
        replacedBySessionId: newSession.id,
      })
      .where(eq(authSessions.id, existingSession.id));

    return response;
  }

  async logout(sessionId: string, userId: string): Promise<{ loggedOut: true }> {
    await this.dbService.db
      .update(authSessions)
      .set({ revokedAt: new Date(), revokeReason: 'user_logout' })
      .where(
        and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)),
      );

    return { loggedOut: true };
  }

  async logoutAllDevices(userId: string): Promise<{ loggedOutAll: true }> {
    await this.dbService.db
      .update(authSessions)
      .set({ revokedAt: new Date(), revokeReason: 'user_logout_all' })
      .where(
        and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)),
      );

    return { loggedOutAll: true };
  }

  async listActiveSessions(
    userId: string,
    currentSessionId: string,
  ): Promise<ActiveSession[]> {
    const now = new Date();
    const rows = await this.dbService.db.query.authSessions.findMany({
      where: and(
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ),
      orderBy: [desc(authSessions.createdAt)],
    });

    return rows.map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      isCurrent: row.id === currentSessionId,
    }));
  }

  async revokeSession(
    userId: string,
    targetSessionId: string,
  ): Promise<{ revoked: true }> {
    const session = await this.dbService.db.query.authSessions.findFirst({
      where: and(
        eq(authSessions.id, targetSessionId),
        eq(authSessions.userId, userId),
      ),
    });

    if (!session) {
      throw new NotFoundException({
        errorCode: 'SESSION_NOT_FOUND',
        message: 'Active session not found',
      });
    }

    await this.dbService.db
      .update(authSessions)
      .set({ revokedAt: new Date(), revokeReason: 'user_revoked_session' })
      .where(eq(authSessions.id, targetSessionId));

    return { revoked: true };
  }

  async initiateTotpSetup(
    userId: string,
  ): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.dbService.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundException({
        errorCode: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const { base32Secret, otpauthUrl } = this.totpService.generateSecret(
      user.email,
    );
    const encrypted = this.totpService.encryptSecret(base32Secret);

    await this.dbService.db
      .update(users)
      .set({
        totpSecretEncrypted: encrypted,
        totpEnabled: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return { secret: base32Secret, otpauthUrl };
  }

  async confirmTotpSetup(
    userId: string,
    code: string,
  ): Promise<{ enabled: true; recoveryCodes: string[] }> {
    const user = await this.dbService.db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user || !user.totpSecretEncrypted) {
      throw new BadRequestException({
        errorCode: 'TOTP_SETUP_NOT_INITIATED',
        message: 'Two-factor setup has not been initiated',
      });
    }

    const secret = this.totpService.decryptSecret(user.totpSecretEncrypted);
    if (!this.totpService.verifyCode(secret, code)) {
      throw new BadRequestException({
        errorCode: 'INVALID_TOTP_CODE',
        message: 'Verification code is invalid',
      });
    }

    const { plainCodes, codeHashes } = this.totpService.generateRecoveryCodes();

    await this.dbService.db
      .update(users)
      .set({
        totpEnabled: true,
        totpRecoveryCodesHashes: codeHashes,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return { enabled: true, recoveryCodes: plainCodes };
  }

  async forgotPassword(
    input: ForgotPasswordRequest,
  ): Promise<{ accepted: true }> {
    const email = input.email.toLowerCase();
    const user = await this.dbService.db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) {
      return { accepted: true };
    }

    const { rawToken, tokenHash } = this.tokenService.generateOpaqueToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await this.dbService.db.insert(verificationTokens).values({
      userId: user.id,
      purpose: 'password_reset',
      tokenHash,
      expiresAt,
    });

    await this.emailService.sendPasswordResetEmail(
      user.email,
      user.fullName,
      rawToken,
    );

    return { accepted: true };
  }

  async resetPassword(
    input: ResetPasswordRequest,
  ): Promise<{ passwordReset: true }> {
    const tokenHash = this.tokenService.hashToken(input.token);

    const tokenRecord =
      await this.dbService.db.query.verificationTokens.findFirst({
        where: and(
          eq(verificationTokens.tokenHash, tokenHash),
          eq(verificationTokens.purpose, 'password_reset'),
        ),
      });

    if (
      !tokenRecord ||
      tokenRecord.usedAt !== null ||
      tokenRecord.expiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException({
        errorCode: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'Password reset token is invalid or has expired',
      });
    }

    const newPasswordHash = await this.passwordService.hash(input.newPassword);
    const now = new Date();

    await this.dbService.db
      .update(verificationTokens)
      .set({ usedAt: now })
      .where(eq(verificationTokens.id, tokenRecord.id));

    await this.dbService.db
      .update(users)
      .set({ passwordHash: newPasswordHash, updatedAt: now })
      .where(eq(users.id, tokenRecord.userId));

    await this.dbService.db
      .update(authSessions)
      .set({ revokedAt: now, revokeReason: 'password_reset' })
      .where(
        and(
          eq(authSessions.userId, tokenRecord.userId),
          isNull(authSessions.revokedAt),
        ),
      );

    return { passwordReset: true };
  }

  private async createSessionAndIssueTokens(
    user: typeof users.$inferSelect,
    meta: RequestMetadata,
    familyId: string = randomUUID(),
  ): Promise<{
    session: typeof authSessions.$inferSelect;
    response: AuthTokensResponse;
  }> {
    const { rawToken: refreshToken, tokenHash: refreshTokenHash } =
      this.tokenService.generateOpaqueToken();

    const expiresAt = new Date(
      Date.now() + this.tokenService.refreshTtlDays * 24 * 60 * 60 * 1000,
    );

    const [session] = await this.dbService.db
      .insert(authSessions)
      .values({
        userId: user.id,
        familyId,
        refreshTokenHash,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt,
      })
      .returning();

    if (!session) {
      throw new Error('Failed to create auth session');
    }

    const accessToken = await this.tokenService.signAccessToken({
      sub: user.id,
      email: user.email,
      sessionId: session.id,
    });

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      emailVerifiedAt: user.emailVerifiedAt
        ? user.emailVerifiedAt.toISOString()
        : null,
      totpEnabled: user.totpEnabled,
      createdAt: user.createdAt.toISOString(),
    };

    return {
      session,
      response: {
        accessToken,
        refreshToken,
        expiresInSeconds: this.tokenService.accessTtlSeconds,
        user: authUser,
      },
    };
  }
}