import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, metadata?: ArgumentMetadata): T {
    if (metadata?.type === 'custom') {
      return value as T;
    }

    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || metadata?.data || 'payload',
        message: issue.message,
      }));

      throw new BadRequestException({
        errorCode: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        issues,
      });
    }

    return parsed.data;
  }
}