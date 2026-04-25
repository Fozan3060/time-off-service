import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { Actor, Role } from './role.enum';
import { ROLES_KEY } from './roles.decorator';

const VALID_ROLES = new Set<string>(Object.values(Role));

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; actor?: Actor }>();

    const role = request.headers['x-role'];
    const actorId = request.headers['x-actor-id'] ?? null;

    if (!role) {
      throw new UnauthorizedException({
        code: 'MISSING_ROLE',
        message: 'X-Role header is required.',
      });
    }
    if (!VALID_ROLES.has(role)) {
      throw new UnauthorizedException({
        code: 'INVALID_ROLE',
        message: `Unknown role: ${role}.`,
      });
    }

    const actor: Actor = { role: role as Role, id: actorId };
    request.actor = actor;

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredRoles && requiredRoles.length > 0) {
      if (!requiredRoles.includes(actor.role)) {
        throw new ForbiddenException({
          code: 'INSUFFICIENT_ROLE',
          message: `This endpoint requires one of: ${requiredRoles.join(', ')}.`,
        });
      }
    }

    return true;
  }
}
