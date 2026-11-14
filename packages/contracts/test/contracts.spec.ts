import { describe, expect, it } from 'vitest';
import {
  ApiErrorResponseSchema,
  HealthStatusSchema,
  OrganizationRoleSchema,
  SignUpRequestSchema,
} from '../src/index';

describe('@teamloom/contracts schemas', () => {
  it('validates a well-formed ApiErrorResponse payload', () => {
    const validError = {
      statusCode: 400,
      errorCode: 'VALIDATION_FAILED',
      message: 'Invalid request payload',
      requestId: 'req_123456',
      timestamp: new Date().toISOString(),
      issues: [{ path: 'email', message: 'Invalid email address' }],
    };

    const parsed = ApiErrorResponseSchema.safeParse(validError);
    expect(parsed.success).toBe(true);
  });

  it('rejects an ApiErrorResponse missing requestId', () => {
    const invalidError = {
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      message: 'Something went wrong',
      timestamp: new Date().toISOString(),
    };

    const parsed = ApiErrorResponseSchema.safeParse(invalidError);
    expect(parsed.success).toBe(false);
  });

  it('validates HealthStatus and OrganizationRole enums', () => {
    expect(
      HealthStatusSchema.safeParse({
        status: 'ok',
        version: '0.1.0',
        timestamp: new Date().toISOString(),
        services: { database: 'up', redis: 'up' },
      }).success,
    ).toBe(true);

    expect(OrganizationRoleSchema.safeParse('owner').success).toBe(true);
    expect(OrganizationRoleSchema.safeParse('superadmin').success).toBe(false);
  });

  it('normalizes email and enforces strong password rules on SignUpRequestSchema', () => {
    const valid = SignUpRequestSchema.safeParse({
      email: '  Founder@Teamloom.io ',
      password: 'StrongPassword123',
      fullName: 'Piyush Ratn',
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.email).toBe('founder@teamloom.io');
    }

    const weakPassword = SignUpRequestSchema.safeParse({
      email: 'founder@teamloom.io',
      password: 'weak',
      fullName: 'Piyush Ratn',
    });
    expect(weakPassword.success).toBe(false);
  });
});