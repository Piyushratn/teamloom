import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AuthTokensResponseSchema } from '@teamloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { runSqlMigrations } from '../src/database/migrate';

describe('AuthController HTTP Endpoints (/auth/*)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const adminUrl =
      process.env.DATABASE_ADMIN_URL ??
      'postgresql://teamloom_admin:teamloom_admin_local_pw@localhost:5432/teamloom_dev';
    await runSqlMigrations(adminUrl);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/signup -> GET /auth/me -> GET /auth/sessions -> POST /auth/logout immediately invalidates JWT', async () => {
    const email = `http_auth_${Date.now()}@teamloom.io`;

    // 1. POST /auth/signup
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email,
        password: 'StrongPassword123',
        fullName: 'HTTP Auth User',
      },
    });

    expect(signupRes.statusCode).toBe(201);
    const tokens = AuthTokensResponseSchema.parse(signupRes.json());

    // 2. GET /auth/me with Bearer token
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().email).toBe(email);

    // 3. GET /auth/sessions
    const sessionsRes = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    expect(sessionsRes.statusCode).toBe(200);
    expect(sessionsRes.json().sessions.length).toBe(1);

    // 4. POST /auth/logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    expect(logoutRes.statusCode).toBe(200);

    // 5. Subsequent GET /auth/me with the same JWT must immediately return 401 SESSION_REVOKED_OR_EXPIRED
    const afterLogoutMe = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    expect(afterLogoutMe.statusCode).toBe(401);
    expect(afterLogoutMe.json().errorCode).toBe('SESSION_REVOKED_OR_EXPIRED');
  });
});