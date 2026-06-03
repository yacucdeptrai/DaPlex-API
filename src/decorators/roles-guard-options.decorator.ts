import { SetMetadata } from '@nestjs/common';

const defaultOptions: PermissionOptions = { permissions: [], optional: false, requireOwner: false };

export const RolesGuardOptions = (options: PermissionOptions) => {
  options = { ...defaultOptions, ...options };
  return SetMetadata('rolesGuardOptions', options);
};

export class PermissionOptions {
  permissions?: number[];
  optional?: boolean;
  requireOwner?: boolean;
}
