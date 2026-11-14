import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginRateLimiterService } from './login-rate-limiter.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    PasswordService,
    TokenService,
    TotpService,
    LoginRateLimiterService,
    AuthService,
    JwtAuthGuard,
  ],
  exports: [
    PasswordService,
    TokenService,
    TotpService,
    AuthService,
    JwtAuthGuard,
  ],
})
export class AuthModule {}