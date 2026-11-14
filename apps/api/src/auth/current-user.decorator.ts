import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export interface AuthenticatedPrincipal {
  userId: string;
  email: string;
  sessionId: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user: AuthenticatedPrincipal }>();
    return request.user;
  },
);