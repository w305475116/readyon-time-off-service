import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { BatchBalanceSyncDto } from './dto/batch-balance-sync.dto';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';
import { SyncBalanceDto } from './dto/sync-balance.dto';
import { AuditEventEntity } from './entities/audit-event.entity';
import {
  BalanceProjectionEntity,
  BalanceProjectionSource
} from './entities/balance-projection.entity';
import {
  RejectionReason,
  TimeOffRequestEntity,
  TimeOffRequestStatus
} from './entities/time-off-request.entity';
import { HcmClient, HcmError, HcmErrorCode } from './hcm/hcm-client';

@Injectable()
export class TimeOffService {
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataSource: DataSource,
    private readonly hcmClient: HcmClient,
    @InjectRepository(TimeOffRequestEntity)
    private readonly requests: Repository<TimeOffRequestEntity>,
    @InjectRepository(BalanceProjectionEntity)
    private readonly balances: Repository<BalanceProjectionEntity>
  ) {}

  async getBalance(employeeId: string, locationId: string): Promise<BalanceProjectionEntity> {
    const balance = await this.balances.findOneBy({ employeeId, locationId });
    if (!balance) {
      throw new NotFoundException({
        code: 'BALANCE_NOT_SYNCED',
        message: 'No synced balance exists for this employee and location.'
      });
    }
    return balance;
  }

  async syncBalance(dto: SyncBalanceDto): Promise<BalanceProjectionEntity> {
    const hcmBalance = await this.callHcm(() => this.hcmClient.getBalance(dto.employeeId, dto.locationId));
    const balance = await this.upsertBalance(
      hcmBalance.employeeId,
      hcmBalance.locationId,
      hcmBalance.availableDays,
      BalanceProjectionSource.RealtimeHcm
    );

    await this.addAuditEvent(this.dataSource.manager, {
      eventType: 'BALANCE_SYNCED',
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      payload: { source: BalanceProjectionSource.RealtimeHcm }
    });

    return balance;
  }

  async batchSync(dto: BatchBalanceSyncDto): Promise<{ upserted: number; unchanged: number }> {
    return this.runSerializedTransaction(async (manager) => {
      let upserted = 0;
      let unchanged = 0;
      const now = new Date();
      const balanceRepository = manager.getRepository(BalanceProjectionEntity);

      for (const incoming of dto.balances) {
        const current = await balanceRepository.findOneBy({
          employeeId: incoming.employeeId,
          locationId: incoming.locationId
        });

        if (
          current &&
          current.availableDays === incoming.availableDays &&
          current.source === BalanceProjectionSource.BatchHcm
        ) {
          unchanged += 1;
          continue;
        }

        await balanceRepository.save({
          employeeId: incoming.employeeId,
          locationId: incoming.locationId,
          availableDays: incoming.availableDays,
          source: BalanceProjectionSource.BatchHcm,
          lastSyncedAt: now
        });
        upserted += 1;
      }

      await this.addAuditEvent(manager, {
        eventType: 'BATCH_BALANCE_SYNC_COMPLETED',
        payload: { received: dto.balances.length, upserted, unchanged }
      });

      return { upserted, unchanged };
    });
  }

  async createRequest(dto: CreateTimeOffRequestDto, idempotencyKey: string | undefined): Promise<TimeOffRequestEntity> {
    if (!idempotencyKey) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required for request creation.'
      });
    }

    const existing = await this.requests.findOneBy({ createIdempotencyKey: idempotencyKey });
    if (existing) {
      if (
        existing.employeeId !== dto.employeeId ||
        existing.locationId !== dto.locationId ||
        existing.requestedDays !== dto.requestedDays
      ) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency-Key was already used with a different request payload.'
        });
      }
      return existing;
    }

    const hcmBalance = await this.callHcm(() => this.hcmClient.getBalance(dto.employeeId, dto.locationId));
    if (hcmBalance.availableDays < dto.requestedDays) {
      throw new ConflictException({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Requested days exceed available balance.'
      });
    }

    return this.runSerializedTransaction(async (manager) => {
      await this.saveBalance(
        manager,
        hcmBalance.employeeId,
        hcmBalance.locationId,
        hcmBalance.availableDays,
        BalanceProjectionSource.RealtimeHcm
      );

      const request = manager.getRepository(TimeOffRequestEntity).create({
        id: `tor_${randomUUID()}`,
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        requestedDays: dto.requestedDays,
        status: TimeOffRequestStatus.PendingManagerApproval,
        rejectionReason: null,
        managerRejectionNote: null,
        createIdempotencyKey: idempotencyKey,
        hcmReferenceId: null,
        lastHcmErrorCode: null,
        lastHcmCheckedAt: new Date()
      });

      const saved = await manager.getRepository(TimeOffRequestEntity).save(request);
      await this.addAuditEvent(manager, {
        eventType: 'REQUEST_CREATED',
        requestId: saved.id,
        employeeId: saved.employeeId,
        locationId: saved.locationId,
        payload: { requestedDays: saved.requestedDays }
      });
      return saved;
    });
  }

  async getRequest(requestId: string): Promise<TimeOffRequestEntity> {
    return this.findRequestOrThrow(requestId);
  }

  async rejectRequest(requestId: string, reason?: string): Promise<TimeOffRequestEntity> {
    return this.runSerializedTransaction(async (manager) => {
      const repository = manager.getRepository(TimeOffRequestEntity);
      const request = await this.findRequestOrThrow(requestId, manager);

      if (request.status !== TimeOffRequestStatus.PendingManagerApproval) {
        throw new ConflictException({
          code: 'INVALID_REQUEST_STATE',
          message: 'Only pending requests can be rejected by a manager.',
          requestId
        });
      }

      request.status = TimeOffRequestStatus.Rejected;
      request.rejectionReason = RejectionReason.ManagerRejected;
      request.managerRejectionNote = reason ?? null;
      request.lastHcmErrorCode = null;
      const saved = await repository.save(request);
      await this.addAuditEvent(manager, {
        eventType: 'REQUEST_REJECTED_BY_MANAGER',
        requestId,
        employeeId: saved.employeeId,
        locationId: saved.locationId,
        payload: { reason: saved.managerRejectionNote }
      });
      return saved;
    });
  }

  async approveRequest(requestId: string): Promise<TimeOffRequestEntity> {
    const transitioned = await this.transitionToApproving(requestId);
    if (!transitioned) {
      return this.findRequestOrThrow(requestId);
    }

    const request = await this.findRequestOrThrow(requestId);

    try {
      const latestBalance = await this.hcmClient.getBalance(request.employeeId, request.locationId);
      await this.upsertBalance(
        latestBalance.employeeId,
        latestBalance.locationId,
        latestBalance.availableDays,
        BalanceProjectionSource.RealtimeHcm
      );

      if (latestBalance.availableDays < request.requestedDays) {
        return this.markRejected(request, RejectionReason.HcmInsufficientBalance, HcmErrorCode.InsufficientBalance);
      }

      const filed = await this.hcmClient.fileTimeOff({
        requestId: request.id,
        employeeId: request.employeeId,
        locationId: request.locationId,
        requestedDays: request.requestedDays
      });

      const remainingBalance =
        filed.availableDays ??
        (await this.hcmClient.getBalance(request.employeeId, request.locationId)).availableDays;

      if (remainingBalance < 0) {
        return this.markNeedsReconciliation(request, HcmErrorCode.ValidationFailed);
      }

      return this.markApproved(request, filed.hcmReferenceId, remainingBalance);
    } catch (error: unknown) {
      if (error instanceof HcmError) {
        if (error.code === HcmErrorCode.InvalidDimensions) {
          return this.markRejected(request, RejectionReason.HcmInvalidDimensions, error.code);
        }
        if (error.code === HcmErrorCode.InsufficientBalance) {
          return this.markRejected(request, RejectionReason.HcmInsufficientBalance, error.code);
        }
        if (error.code === HcmErrorCode.Unavailable || error.ambiguous) {
          return this.markNeedsReconciliation(request, error.code);
        }
        return this.markRejected(request, RejectionReason.HcmValidationFailed, error.code);
      }
      return this.markNeedsReconciliation(request, HcmErrorCode.AmbiguousOutcome);
    }
  }

  async reconcileRequest(requestId: string): Promise<TimeOffRequestEntity> {
    const request = await this.findRequestOrThrow(requestId);
    if (
      request.status !== TimeOffRequestStatus.NeedsReconciliation &&
      request.status !== TimeOffRequestStatus.ApprovingWithHcm
    ) {
      return request;
    }

    try {
      const status = await this.hcmClient.getFilingStatus(request.id);
      if (status.status === 'FILED') {
        return this.markApproved(request, status.hcmReferenceId, status.availableDays);
      }
      if (status.status === 'NOT_FOUND') {
        return this.runSerializedTransaction(async (manager) => {
          const repository = manager.getRepository(TimeOffRequestEntity);
          request.status = TimeOffRequestStatus.PendingManagerApproval;
          request.lastHcmErrorCode = null;
          request.lastHcmCheckedAt = new Date();
          const saved = await repository.save(request);
          await this.addAuditEvent(manager, {
            eventType: 'RECONCILIATION_RETURNED_TO_PENDING',
            requestId: request.id,
            employeeId: request.employeeId,
            locationId: request.locationId
          });
          return saved;
        });
      }
      return this.markNeedsReconciliation(request, HcmErrorCode.AmbiguousOutcome);
    } catch {
      return this.markNeedsReconciliation(request, HcmErrorCode.Unavailable);
    }
  }

  private async transitionToApproving(requestId: string): Promise<boolean> {
    const result = await this.requests.update(
      { id: requestId, status: TimeOffRequestStatus.PendingManagerApproval },
      {
        status: TimeOffRequestStatus.ApprovingWithHcm,
        lastHcmErrorCode: null,
        lastHcmCheckedAt: new Date()
      }
    );

    if (!result.affected) {
      const existing = await this.requests.findOneBy({ id: requestId });
      if (!existing) {
        throw new NotFoundException({
          code: 'REQUEST_NOT_FOUND',
          message: 'Time-off request was not found.',
          requestId
        });
      }
      return false;
    }

    const request = await this.requests.findOneByOrFail({ id: requestId });
    await this.addAuditEvent(this.dataSource.manager, {
      eventType: 'REQUEST_APPROVING_WITH_HCM',
      requestId,
      employeeId: request.employeeId,
      locationId: request.locationId
    });
    return true;
  }

  private async markApproved(
    request: TimeOffRequestEntity,
    hcmReferenceId: string,
    availableDays: number | undefined
  ): Promise<TimeOffRequestEntity> {
    return this.runSerializedTransaction(async (manager) => {
      const repository = manager.getRepository(TimeOffRequestEntity);
      request.status = TimeOffRequestStatus.Approved;
      request.rejectionReason = null;
      request.managerRejectionNote = null;
      request.hcmReferenceId = hcmReferenceId;
      request.lastHcmErrorCode = null;
      request.lastHcmCheckedAt = new Date();

      if (typeof availableDays === 'number') {
        await this.saveBalance(
          manager,
          request.employeeId,
          request.locationId,
          availableDays,
          BalanceProjectionSource.RealtimeHcm
        );
      }

      const saved = await repository.save(request);
      await this.addAuditEvent(manager, {
        eventType: 'HCM_FILE_SUCCEEDED',
        requestId: request.id,
        employeeId: request.employeeId,
        locationId: request.locationId,
        payload: { hcmReferenceId }
      });
      return saved;
    });
  }

  private async markRejected(
    request: TimeOffRequestEntity,
    rejectionReason: RejectionReason,
    hcmErrorCode: HcmErrorCode
  ): Promise<TimeOffRequestEntity> {
    return this.runSerializedTransaction(async (manager) => {
      const repository = manager.getRepository(TimeOffRequestEntity);
      request.status = TimeOffRequestStatus.Rejected;
      request.rejectionReason = rejectionReason;
      request.managerRejectionNote = null;
      request.lastHcmErrorCode = hcmErrorCode;
      request.lastHcmCheckedAt = new Date();
      const saved = await repository.save(request);
      await this.addAuditEvent(manager, {
        eventType: 'HCM_FILE_REJECTED',
        requestId: request.id,
        employeeId: request.employeeId,
        locationId: request.locationId,
        payload: { rejectionReason, hcmErrorCode }
      });
      return saved;
    });
  }

  private async markNeedsReconciliation(
    request: TimeOffRequestEntity,
    hcmErrorCode: HcmErrorCode
  ): Promise<TimeOffRequestEntity> {
    return this.runSerializedTransaction(async (manager) => {
      const repository = manager.getRepository(TimeOffRequestEntity);
      request.status = TimeOffRequestStatus.NeedsReconciliation;
      request.lastHcmErrorCode = hcmErrorCode;
      request.lastHcmCheckedAt = new Date();
      const saved = await repository.save(request);
      await this.addAuditEvent(manager, {
        eventType: 'RECONCILIATION_REQUIRED',
        requestId: request.id,
        employeeId: request.employeeId,
        locationId: request.locationId,
        payload: { hcmErrorCode }
      });
      return saved;
    });
  }

  private async upsertBalance(
    employeeId: string,
    locationId: string,
    availableDays: number,
    source: BalanceProjectionSource
  ): Promise<BalanceProjectionEntity> {
    return this.runSerializedTransaction((manager) =>
      this.saveBalance(manager, employeeId, locationId, availableDays, source)
    );
  }

  private async runSerializedTransaction<T>(
    operation: (manager: EntityManager) => Promise<T>
  ): Promise<T> {
    const previousTransaction = this.transactionQueue;
    let releaseCurrentTransaction = (): void => undefined;

    this.transactionQueue = new Promise<void>((resolve) => {
      releaseCurrentTransaction = resolve;
    });

    await previousTransaction;

    try {
      return await this.dataSource.transaction(operation);
    } finally {
      releaseCurrentTransaction();
    }
  }

  private async saveBalance(
    manager: EntityManager,
    employeeId: string,
    locationId: string,
    availableDays: number,
    source: BalanceProjectionSource
  ): Promise<BalanceProjectionEntity> {
    return manager.getRepository(BalanceProjectionEntity).save({
      employeeId,
      locationId,
      availableDays,
      source,
      lastSyncedAt: new Date()
    });
  }

  private async findRequestOrThrow(
    requestId: string,
    manager: EntityManager = this.dataSource.manager
  ): Promise<TimeOffRequestEntity> {
    const request = await manager.getRepository(TimeOffRequestEntity).findOneBy({ id: requestId });
    if (!request) {
      throw new NotFoundException({
        code: 'REQUEST_NOT_FOUND',
        message: 'Time-off request was not found.',
        requestId
      });
    }
    return request;
  }

  private async callHcm<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof HcmError) {
        if (error.code === HcmErrorCode.InvalidDimensions) {
          throw new BadRequestException({
            code: 'INVALID_DIMENSIONS',
            message: error.message
          });
        }
        if (error.code === HcmErrorCode.InsufficientBalance) {
          throw new ConflictException({
            code: 'INSUFFICIENT_BALANCE',
            message: error.message
          });
        }
        throw new ServiceUnavailableException({
          code: 'HCM_UNAVAILABLE',
          message: error.message
        });
      }
      throw error;
    }
  }

  private async addAuditEvent(
    manager: EntityManager,
    event: {
      eventType: string;
      requestId?: string;
      employeeId?: string;
      locationId?: string;
      payload?: Record<string, unknown>;
    }
  ): Promise<void> {
    await manager.getRepository(AuditEventEntity).save({
      eventType: event.eventType,
      requestId: event.requestId ?? null,
      employeeId: event.employeeId ?? null,
      locationId: event.locationId ?? null,
      payload: event.payload ?? null
    });
  }
}
