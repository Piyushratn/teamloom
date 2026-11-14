import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RefreshTokenRequestSchema,
  ResetPasswordRequestSchema,
  SignUpRequestSchema,
  TotpVerifySetupRequestSchema,
  VerifyEmailRequestSchema,
  type ActiveSession,
  type AuthTokensResponse,
  type AuthUser,
  type ForgotPasswordRequest,
  type LoginRequest,
  type RefreshTokenRequest,
  type ResetPasswordRequest,
  type SignUpRequest,
  type TotpVerifySetupRequest,
  type VerifyEmailRequest,
} from '@teamloom/contracts';
import { eq } from 'drizzle-orm';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { DatabaseService } from '../database/database.module';
import { users } from '../database/schema';
import { AuthService, type RequestMetadata } from './auth.service';
import {
  CurrentUser,
  type AuthenticatedPrincipal,
} from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

interface FastifyRequestWithIp {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
  ) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signUp(
    @Body(new ZodValidationPipe(SignUpRequestSchema)) body: SignUpRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<AuthTokensResponse> {
    return this.authService.signUp(body, this.extractMeta(req));
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body(new ZodValidationPipe(VerifyEmailRequestSchema))
    body: VerifyEmailRequest,
  ): Promise<{ verified: true }> {
    return this.authService.verifyEmail(body);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<AuthTokensResponse> {
    return this.authService.login(body, this.extractMeta(req));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(new ZodValidationPipe(RefreshTokenRequestSchema))
    body: RefreshTokenRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<AuthTokensResponse> {
    return this.authService.refreshTokens(body, this.extractMeta(req));
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordRequestSchema))
    body: ForgotPasswordRequest,
  ): Promise<{ accepted: true }> {
    return this.authService.forgotPassword(body);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body(new ZodValidationPipe(ResetPasswordRequestSchema))
    body: ResetPasswordRequest,
  ): Promise<{ passwordReset: true }> {
    return this.authService.resetPassword(body);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() principal: AuthenticatedPrincipal): Promise<AuthUser> {
    const user = await this.dbService.db.query.users.findFirst({
      where: eq(users.id, principal.userId),
    });

    if (!user) {
      throw new Error('Authenticated user record not found');
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      emailVerifiedAt: user.emailVerifiedAt
        ? user.emailVerifiedAt.toISOString()
        : null,
      totpEnabled: user.totpEnabled,
      createdAt: user.createdAt.toISOString(),
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async logout(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ loggedOut: true }> {
    return this.authService.logout(principal.sessionId, principal.userId);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async logoutAll(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ loggedOutAll: true }> {
    return this.authService.logoutAllDevices(principal.userId);
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async listSessions(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ sessions: ActiveSession[] }> {
    const sessions = await this.authService.listActiveSessions(
      principal.userId,
      principal.sessionId,
    );
    return { sessions };
  }

  @Delete('sessions/:sessionId')
  @UseGuards(JwtAuthGuard)
  async revokeSession(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ): Promise<{ revoked: true }> {
    return this.authService.revokeSession(principal.userId, sessionId);
  }

  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async setupTotp(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ secret: string; otpauthUrl: string }> {
    return this.authService.initiateTotpSetup(principal.userId);
  }

  @Post('2fa/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async confirmTotp(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(TotpVerifySetupRequestSchema))
    body: TotpVerifySetupRequest,
  ): Promise<{ enabled: true; recoveryCodes: string[] }> {
    return this.authService.confirmTotpSetup(principal.userId, body.code);
  }

  private extractMeta(req: FastifyRequestWithIp): RequestMetadata {
    const rawUa = req.headers['user-agent'];
    const userAgent =
      (Array.isArray(rawUa) ? rawUa[0] : rawUa) ?? 'unknown-agent';
    return {
      ipAddress: req.ip ?? '127.0.0.1',
      userAgent,
    };
  }
}