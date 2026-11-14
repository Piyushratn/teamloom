import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.module';
import { authSessions } from '../database/schema';
import type { AuthenticatedPrincipal } from './current-user.decorator';
import { TokenService } from './token.service';

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedPrincipal;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(TokenService) private readonly tokenService: TokenService,
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const rawAuth = request.headers.authorization;
    const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        errorCode: 'MISSING_BEARER_TOKEN',
        message: 'Authorization Bearer token is required',
      });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const payload = await this.tokenService.verifyAccessToken(token);

    // Verify the backing session is still active and unrevoked
    const activeSession =
      await this.dbService.db.query.authSessions.findFirst({
        where: and(
          eq(authSessions.id, payload.sessionId),
          eq(authSessions.userId, payload.sub),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, new Date()),
        ),
      });

    if (!activeSession) {
      throw new UnauthorizedException({
        errorCode: 'SESSION_REVOKED_OR_EXPIRED',
        message: 'Session has been revoked or expired',
      });
    }

    request.user = {
      userId: payload.sub,
      email: payload.email,
      sessionId: payload.sessionId,
    };

    return true;
  }
}