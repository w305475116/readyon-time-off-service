import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';

export enum TimeOffRequestStatus {
  PendingManagerApproval = 'PENDING_MANAGER_APPROVAL',
  ApprovingWithHcm = 'APPROVING_WITH_HCM',
  Approved = 'APPROVED',
  Rejected = 'REJECTED',
  NeedsReconciliation = 'NEEDS_RECONCILIATION'
}

export enum RejectionReason {
  ManagerRejected = 'MANAGER_REJECTED',
  HcmInvalidDimensions = 'HCM_INVALID_DIMENSIONS',
  HcmInsufficientBalance = 'HCM_INSUFFICIENT_BALANCE',
  HcmValidationFailed = 'HCM_VALIDATION_FAILED'
}

@Entity('time_off_requests')
export class TimeOffRequestEntity {
  @PrimaryColumn()
  id!: string;

  @Column()
  employeeId!: string;

  @Column()
  locationId!: string;

  @Column('real')
  requestedDays!: number;

  @Column({
    type: 'text',
    enum: TimeOffRequestStatus
  })
  status!: TimeOffRequestStatus;

  @Column({
    type: 'text',
    enum: RejectionReason,
    nullable: true
  })
  rejectionReason!: RejectionReason | null;

  @Column({ type: 'text', nullable: true })
  managerRejectionNote!: string | null;

  @Index({ unique: true })
  @Column({ type: 'text', nullable: true })
  createIdempotencyKey!: string | null;

  @Column({ type: 'text', nullable: true })
  hcmReferenceId!: string | null;

  @Column({ type: 'text', nullable: true })
  lastHcmErrorCode!: string | null;

  @Column({ type: 'datetime', nullable: true })
  lastHcmCheckedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
