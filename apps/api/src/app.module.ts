import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { validateEnv, type AppEnv } from './config/env.schema';
import { DatabaseModule } from './database/database.module';
import { EmailModule } from './email/email.module';
import { HealthModule } from './health/health.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => {
        const nodeEnv = config.get('NODE_ENV', { infer: true });
        return {
          pinoHttp: {
            level:
              nodeEnv === 'test'
                ? 'silent'
                : nodeEnv === 'production'
                  ? 'info'
                  : 'debug',
            genReqId: (req) => {
              const existing = req.headers['x-request-id'];
              if (typeof existing === 'string' && existing.length > 0) {
                return existing;
              }
              return `req_${randomUUID()}`;
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.newPassword',
                'req.body.token',
                'req.body.refreshToken',
              ],
              censor: '[REDACTED]',
            },
            transport:
              nodeEnv === 'development'
                ? {
                    target: 'pino-pretty',
                    options: {
                      colorize: true,
                      singleLine: true,
                      translateTime: 'SYS:standard',
                    },
                  }
                : undefined,
          },
        };
      },
    }),
    DatabaseModule,
    RedisModule,
    EmailModule,
    AuthModule,
    OrganizationsModule,
    HealthModule,
  ],
})
export class AppModule {}