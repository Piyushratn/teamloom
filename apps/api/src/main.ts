import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppEnv } from './config/env.schema';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: 1024 * 1024,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      genReqId: (req: any) => {
        const existing = req.headers?.['x-request-id'];
        if (typeof existing === 'string' && existing.length > 0) {
          return existing;
        }
        return `req_${randomUUID()}`;
      },
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new GlobalExceptionFilter());

  const configService = app.get<ConfigService<AppEnv, true>>(ConfigService);
  const port = configService.get('PORT', { infer: true });
  const host = configService.get('HOST', { infer: true });
  const corsOrigin = configService.get('CORS_ORIGIN', { infer: true });

  app.enableCors({
    origin: corsOrigin.split(',').map((o: string) => o.trim()),
    credentials: true,
  });

  app.enableShutdownHooks();

  await app.listen(port, host);
  app.get(Logger).log(`Teamloom API listening on http://${host}:${port}`);
}

void bootstrap();