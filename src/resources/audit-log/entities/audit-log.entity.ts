import { AuditLogChange } from './audit-log-change.entity';

export class AuditLog {
  _id: bigint;

  user: bigint;

  target: bigint;

  targetRef: string;

  type: number;

  changes: AuditLogChange[];

  createdAt: Date;
}
