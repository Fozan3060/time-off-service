import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Actor } from './role.enum';

export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor => {
    const request = ctx.switchToHttp().getRequest<{ actor?: Actor }>();
    if (!request.actor) {
      throw new Error(
        'CurrentActor decorator used on a route without AuthGuard',
      );
    }
    return request.actor;
  },
);
