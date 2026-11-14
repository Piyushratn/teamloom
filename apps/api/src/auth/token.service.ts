import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AppEnv } from '../config/env.schema';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  sessionId: string;
}

@Injectable()
export class TokenService {
  private readonly secret: string;
  public readonly accessTtlSeconds: number;
  public readonly refreshTtlDays: number;

  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ConfigService) config: ConfigService<AppEnv, true>,
  ) {
    this.secret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.accessTtlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    this.refreshTtlDays = config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
  }

  async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwtService.signAsync(payload, {
      secret: this.secret,
      expiresIn: this.accessTtlSeconds,
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      return await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.secret,
      });
    } catch {
      throw new UnauthorizedException({
        errorCode: 'INVALID_ACCESS_TOKEN',
        message: 'Access token is invalid or expired',
      });
    }
  }

  /**
   * Generates a 256-bit cryptographically random URL-safe token and its SHA-256 database hash.
   */
  generateOpaqueToken(): { rawToken: string; tokenHash: string } {
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);
    return { rawToken, tokenHash };
  }

  hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}