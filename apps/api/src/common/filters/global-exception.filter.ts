import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorIssue, ApiErrorResponse } from '@teamloom/contracts';
import { ZodError } from 'zod';

interface FastifyRequestLike {
  id?: string;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
}

interface FastifyReplyLike {
  header(name: string, value: string): FastifyReplyLike;
  status(code: number): FastifyReplyLike;
  send(payload: unknown): void;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequestLike>();
    const reply = ctx.getResponse<FastifyReplyLike>();

    const headerReqId = request.headers['x-request-id'];
    const requestId =
      (Array.isArray(headerReqId) ? headerReqId[0] : headerReqId) ??
      (typeof request.id === 'string' ? request.id : `req_${Date.now()}`);

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected internal error occurred';
    let issues: ApiErrorIssue[] | undefined;

    if (exception instanceof ZodError) {
      statusCode = HttpStatus.BAD_REQUEST;
      errorCode = 'VALIDATION_FAILED';
      message = 'Request validation failed';
      issues = exception.issues.map((issue) => ({
        path: issue.path.join('.') || 'root',
        message: issue.message,
      }));
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
        errorCode = this.mapStatusToCode(statusCode);
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        errorCode =
          typeof resObj.errorCode === 'string'
            ? resObj.errorCode
            : this.mapStatusToCode(statusCode);
        message =
          typeof resObj.message === 'string'
            ? resObj.message
            : exception.message;
        if (Array.isArray(resObj.issues)) {
          issues = resObj.issues as ApiErrorIssue[];
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}: ${exception.message}`,
        exception.stack,
      );
    }

    const payload: ApiErrorResponse = {
      statusCode,
      errorCode,
      message,
      requestId,
      timestamp: new Date().toISOString(),
      ...(issues ? { issues } : {}),
    };

    reply
      .header('x-request-id', requestId)
      .status(statusCode)
      .send(payload);
  }

  private mapStatusToCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      default:
        return 'HTTP_ERROR';
    }
  }
}