import { type ArgumentsHost, BadRequestException } from '@nestjs/common';
import { ApiErrorResponseSchema } from '@teamloom/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { ZodValidationPipe } from '../src/common/pipes/zod-validation.pipe';

function createMockHost(requestId = 'req_test_999') {
  let capturedStatus = 200;
  let capturedPayload: unknown = null;
  const capturedHeaders: Record<string, string> = {};

  const reply = {
    header(name: string, value: string) {
      capturedHeaders[name] = value;
      return reply;
    },
    status(code: number) {
      capturedStatus = code;
      return reply;
    },
    send(payload: unknown) {
      capturedPayload = payload;
    },
  };

  const request = {
    id: requestId,
    headers: {},
    method: 'POST',
    url: '/api/test',
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    getStatus: () => capturedStatus,
    getPayload: () => capturedPayload,
    getHeaders: () => capturedHeaders,
  };
}

describe('ZodValidationPipe & GlobalExceptionFilter', () => {
  it('formats Zod validation failures into a valid ApiErrorResponse', () => {
    const schema = z.object({
      email: z.string().email(),
      name: z.string().min(2),
    });
    const pipe = new ZodValidationPipe(schema);
    const filter = new GlobalExceptionFilter();
    const mock = createMockHost('req_zod_123');

    let caughtError: unknown;
    try {
      pipe.transform({ email: 'not-an-email', name: 'A' });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    filter.catch(caughtError, mock.host);

    expect(mock.getStatus()).toBe(400);
    expect(mock.getHeaders()['x-request-id']).toBe('req_zod_123');

    const parsed = ApiErrorResponseSchema.safeParse(mock.getPayload());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.errorCode).toBe('VALIDATION_FAILED');
      expect(parsed.data.issues?.length).toBe(2);
    }
  });

  it('masks unexpected runtime errors as 500 INTERNAL_SERVER_ERROR without leaking stack traces', () => {
    const filter = new GlobalExceptionFilter();
    const mock = createMockHost('req_crash_500');

    filter.catch(new Error('Database connection string leaked'), mock.host);

    expect(mock.getStatus()).toBe(500);
    const parsed = ApiErrorResponseSchema.safeParse(mock.getPayload());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.errorCode).toBe('INTERNAL_SERVER_ERROR');
      expect(parsed.data.message).toBe('An unexpected internal error occurred');
    }
  });
});