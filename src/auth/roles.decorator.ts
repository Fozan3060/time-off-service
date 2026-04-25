import { SetMetadata } from '@nestjs/common';
import { Role } from './role.enum';

export const ROLES_KEY = 'auth:roles';

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
