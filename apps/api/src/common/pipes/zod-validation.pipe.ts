import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { type ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'root',
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