import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogService } from '../src/audit/audit-log.service';
import { AuthService } from '../src/auth/auth.service';
import { LoginRateLimiterService } from '../src/auth/login-rate-limiter.service';
import { PasswordService } from '../src/auth/password.service';
import { TokenService } from '../src/auth/token.service';
import { TotpService } from '../src/auth/totp.service';
import { validateEnv, type AppEnv } from '../src/config/env.schema';
import { DatabaseService } from '../src/database/database.module';
import { runSqlMigrations } from '../src/database/migrate';
import { EmailService } from '../src/email/email.service';
import { OrganizationsService } from '../src/organizations/organizations.service';
import { RedisService } from '../src/redis/redis.module';

describe('OrganizationsService (Create, Invite, Accept, Roles, Ownership Transfer & Audit Log)', () => {
  let dbService: DatabaseService;
  let redisService: RedisService;
  let emailService: EmailService;
  let authService: AuthService;
  let orgsService: OrganizationsService;
  let auditLogService: AuditLogService;

  const meta = { ipAddress: '127.0.0.1', userAgent: 'Vitest-Org/1.0' };

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

    const tokenService = new TokenService(new JwtService(), configService);
    const rateLimiter = new LoginRateLimiterService(redisService);
    emailService = new EmailService(configService);
    const totpService = new TotpService(configService);

    authService = new AuthService(
      dbService,
      passwordService,
      tokenService,
      rateLimiter,
      emailService,
      totpService,
    );

    auditLogService = new AuditLogService(dbService);
    orgsService = new OrganizationsService(
      dbService,
      tokenService,
      emailService,
      auditLogService,
    );
  });

  afterAll(async () => {
    await dbService.onModuleDestroy();
    await redisService.onModuleDestroy();
  });

  it('creates an organization, invites a member, accepts invite, updates role, transfers ownership, and records audit logs', async () => {
    const suffix = Date.now();
    const aliceEmail = `alice_org_${suffix}@teamloom.io`;
    const bobEmail = `bob_org_${suffix}@teamloom.io`;

    const alice = await authService.signUp(
      {
        email: aliceEmail,
        password: 'StrongPassword123',
        fullName: 'Alice Founder',
      },
      meta,
    );

    const bob = await authService.signUp(
      {
        email: bobEmail,
        password: 'StrongPassword123',
        fullName: 'Bob Engineer',
      },
      meta,
    );

    // 1. Alice creates an organization
    const org = await orgsService.createOrganization(
      alice.user.id,
      {
        name: 'Teamloom Labs',
        slug: `teamloom-labs-${suffix}`,
      },
      meta,
    );

    expect(org.myRole).toBe('owner');

    // 2. Alice invites Bob as 'member'
    await orgsService.inviteMember(
      org.id,
      alice.user.id,
      {
        email: bobEmail,
        role: 'member',
        guestProjectIds: [],
      },
      meta,
    );

    const inviteMail = emailService.testOutbox.find(
      (m) => m.to === bobEmail && m.subject.includes('Teamloom Labs'),
    );
    expect(inviteMail?.token).toBeDefined();

    // Alice trying to accept Bob's invite must fail with 403 INVITE_EMAIL_MISMATCH
    await expect(
      orgsService.acceptInvite(
        alice.user.id,
        aliceEmail,
        { token: inviteMail!.token! },
        meta,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // 3. Bob accepts his invite
    const joinedOrg = await orgsService.acceptInvite(
      bob.user.id,
      bobEmail,
      { token: inviteMail!.token! },
      meta,
    );
    expect(joinedOrg.id).toBe(org.id);
    expect(joinedOrg.myRole).toBe('member');

    // 4. Alice promotes Bob to 'admin'
    const roleUpdate = await orgsService.updateMemberRole(
      org.id,
      alice.user.id,
      bob.user.id,
      { role: 'admin' },
      meta,
    );
    expect(roleUpdate.role).toBe('admin');

    // 5. Alice transfers organization ownership to Bob
    const transfer = await orgsService.transferOwnership(
      org.id,
      alice.user.id,
      { newOwnerUserId: bob.user.id },
      meta,
    );
    expect(transfer.transferred).toBe(true);

    const members = await orgsService.listMembers(org.id, bob.user.id);
    const aliceMember = members.find((m) => m.userId === alice.user.id);
    const bobMember = members.find((m) => m.userId === bob.user.id);
    expect(aliceMember?.role).toBe('admin');
    expect(bobMember?.role).toBe('owner');

    // 6. Verify audit log trail recorded all 5 security events
    const logs = await auditLogService.listForOrganization(org.id, bob.user.id);
    const actions = logs.map((l) => l.action);
    expect(actions).toContain('org.created');
    expect(actions).toContain('member.invited');
    expect(actions).toContain('member.invite_accepted');
    expect(actions).toContain('member.role_updated');
    expect(actions).toContain('org.ownership_transferred');
  });
});