import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  TimeOffRequestEntity,
  TimeOffRequestStatus
} from '../src/time-off/entities/time-off-request.entity';
import { MockHcmServer } from './mock-hcm';

describe('ReadyOn time-off service (e2e)', () => {
  let app: INestApplication;
  const hcm = new MockHcmServer();

  beforeAll(async () => {
    await hcm.start();
  });

  afterAll(async () => {
    await hcm.stop();
  });

  beforeEach(async () => {
    hcm.reset();
    process.env.DATABASE_PATH = ':memory:';
    process.env.HCM_BASE_URL = hcm.baseUrl;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true
      })
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer()).get('/health').expect(200).expect({
      status: 'ok'
    });
  });

  it('syncs and reads a single balance projection', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);

    await request(app.getHttpServer())
      .post('/balances/sync')
      .send({ employeeId: 'emp_123', locationId: 'loc_001' })
      .expect(201)
      .expect((response) => {
        expect(response.body.availableDays).toBe(10);
        expect(response.body.source).toBe('REALTIME_HCM');
        expect(response.body.lastSyncedAt).toBeDefined();
      });

    await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp_123', locationId: 'loc_001' })
      .expect(200)
      .expect((response) => {
        expect(response.body.availableDays).toBe(10);
      });
  });

  it('creates a pending request and de-duplicates creation retries', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);

    const first = await createRequest('create-1', 2);
    const retry = await createRequest('create-1', 2);

    expect(first.body.id).toBe(retry.body.id);
    expect(first.body.status).toBe(TimeOffRequestStatus.PendingManagerApproval);
  });

  it('fails closed when HCM reports insufficient balance during creation', async () => {
    hcm.setBalance('emp_123', 'loc_001', 1);

    await request(app.getHttpServer())
      .post('/time-off-requests')
      .set('Idempotency-Key', 'create-insufficient')
      .send({ employeeId: 'emp_123', locationId: 'loc_001', requestedDays: 2 })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe('INSUFFICIENT_BALANCE');
      });
  });

  it('fails closed when HCM reports invalid dimensions during creation', async () => {
    await request(app.getHttpServer())
      .post('/time-off-requests')
      .set('Idempotency-Key', 'create-invalid-dimensions')
      .send({ employeeId: 'emp_missing', locationId: 'loc_missing', requestedDays: 1 })
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('INVALID_DIMENSIONS');
      });
  });

  it('fails closed when HCM is unavailable during creation', async () => {
    hcm.setBalanceBehavior('server-error');

    await request(app.getHttpServer())
      .post('/time-off-requests')
      .set('Idempotency-Key', 'create-hcm-down')
      .send({ employeeId: 'emp_123', locationId: 'loc_001', requestedDays: 1 })
      .expect(503)
      .expect((response) => {
        expect(response.body.code).toBe('HCM_UNAVAILABLE');
      });
  });

  it('rejects reused creation idempotency keys with different payloads', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);

    await createRequest('create-reused-key', 2);

    await request(app.getHttpServer())
      .post('/time-off-requests')
      .set('Idempotency-Key', 'create-reused-key')
      .send({ employeeId: 'emp_123', locationId: 'loc_001', requestedDays: 3 })
      .expect(409)
      .expect((response) => {
        expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      });
  });

  it('manager rejection does not call HCM filing', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const created = await createRequest('create-manager-reject', 2);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.id}/reject`)
      .send({ reason: 'Out of coverage window' })
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.Rejected);
        expect(response.body.rejectionReason).toBe('MANAGER_REJECTED');
        expect(response.body.managerRejectionNote).toBe('Out of coverage window');
      });

    expect(hcm.filePostCalls).toBe(0);
  });

  it('approves a request only after HCM confirms filing', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const created = await createRequest('create-approve', 2);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.id}/approve`)
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.Approved);
        expect(response.body.hcmReferenceId).toBe(`hcm_${created.body.id}`);
      });

    await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp_123', locationId: 'loc_001' })
      .expect(200)
      .expect((response) => {
        expect(response.body.availableDays).toBe(8);
      });
  });

  it('does not double-file approval retries after a request is already approved', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const created = await createRequest('create-approval-retry', 2);

    await request(app.getHttpServer()).post(`/time-off-requests/${created.body.id}/approve`).expect(201);
    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.id}/approve`)
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.Approved);
      });

    expect(hcm.filePostCalls).toBe(1);
  });

  it('rejects approval when HCM balance changed after request creation', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const created = await createRequest('create-stale-balance', 8);
    hcm.setBalance('emp_123', 'loc_001', 5);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.id}/approve`)
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.Rejected);
        expect(response.body.rejectionReason).toBe('HCM_INSUFFICIENT_BALANCE');
      });
  });

  it('rejects approval when HCM dimensions become invalid after creation', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const created = await createRequest('create-invalid-approval-dimensions', 2);
    hcm.deleteBalance('emp_123', 'loc_001');

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.id}/approve`)
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.Rejected);
        expect(response.body.rejectionReason).toBe('HCM_INVALID_DIMENSIONS');
      });
  });

  it('marks approval as needs reconciliation when HCM filing returns a server error', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const created = await createRequest('create-filing-500', 2);
    hcm.setFileBehavior('server-error');

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.id}/approve`)
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.NeedsReconciliation);
        expect(response.body.lastHcmErrorCode).toBe('HCM_UNAVAILABLE');
      });
  });

  it('reconciles an approval when HCM filed the request but the response was lost', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const created = await createRequest('create-reconcile', 2);
    hcm.setFileBehavior('socket-close-after-filing');

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.id}/approve`)
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.NeedsReconciliation);
      });

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.id}/reconcile`)
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.Approved);
        expect(response.body.hcmReferenceId).toBe(`hcm_${created.body.id}`);
      });
  });

  it('does not double-file concurrent approvals for the same request', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const created = await createRequest('create-concurrent', 2);

    await Promise.all([
      request(app.getHttpServer()).post(`/time-off-requests/${created.body.id}/approve`).expect(201),
      request(app.getHttpServer()).post(`/time-off-requests/${created.body.id}/approve`).expect(201)
    ]);

    expect(hcm.filePostCalls).toBe(1);
    await request(app.getHttpServer())
      .get(`/time-off-requests/${created.body.id}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.Approved);
      });
  });

  it('prevents concurrent approvals for separate requests from overdrawing the same employee/location balance', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const first = await createRequest('create-concurrent-first', 6);
    const second = await createRequest('create-concurrent-second', 6);

    const approvals = await Promise.all([
      request(app.getHttpServer()).post(`/time-off-requests/${first.body.id}/approve`).expect(201),
      request(app.getHttpServer()).post(`/time-off-requests/${second.body.id}/approve`).expect(201)
    ]);

    const statuses = approvals.map((approval) => approval.body.status).sort();
    expect(statuses).toEqual([TimeOffRequestStatus.Approved, TimeOffRequestStatus.Rejected].sort());
    expect(approvals.some((approval) => approval.body.rejectionReason === 'HCM_INSUFFICIENT_BALANCE')).toBe(true);

    await request(app.getHttpServer())
      .post('/balances/sync')
      .send({ employeeId: 'emp_123', locationId: 'loc_001' })
      .expect(201)
      .expect((response) => {
        expect(response.body.availableDays).toBe(4);
      });
  });

  it('reconciles an in-progress approval back to pending when HCM has no filing record', async () => {
    hcm.setBalance('emp_123', 'loc_001', 10);
    const created = await createRequest('create-stuck-approving', 2);
    await forceRequestStatus(created.body.id, TimeOffRequestStatus.ApprovingWithHcm);

    await request(app.getHttpServer())
      .post(`/time-off-requests/${created.body.id}/reconcile`)
      .expect(201)
      .expect((response) => {
        expect(response.body.status).toBe(TimeOffRequestStatus.PendingManagerApproval);
        expect(response.body.lastHcmErrorCode).toBeNull();
      });
  });

  it('batch sync writes changed rows and skips unchanged rows', async () => {
    const snapshot = {
      balances: [
        { employeeId: 'emp_123', locationId: 'loc_001', availableDays: 10 },
        { employeeId: 'emp_456', locationId: 'loc_001', availableDays: 6 }
      ]
    };

    await request(app.getHttpServer())
      .post('/hcm-sync/balances')
      .send(snapshot)
      .expect(201)
      .expect((response) => {
        expect(response.body).toEqual({ upserted: 2, unchanged: 0 });
      });

    await request(app.getHttpServer())
      .post('/hcm-sync/balances')
      .send(snapshot)
      .expect(201)
      .expect((response) => {
        expect(response.body).toEqual({ upserted: 0, unchanged: 2 });
      });
  });

  function createRequest(idempotencyKey: string, requestedDays: number) {
    return request(app.getHttpServer())
      .post('/time-off-requests')
      .set('Idempotency-Key', idempotencyKey)
      .send({ employeeId: 'emp_123', locationId: 'loc_001', requestedDays })
      .expect(201);
  }

  async function forceRequestStatus(requestId: string, status: TimeOffRequestStatus): Promise<void> {
    await app.get(DataSource).getRepository(TimeOffRequestEntity).update(
      { id: requestId },
      {
        status,
        lastHcmCheckedAt: new Date(Date.now() - 60_000)
      }
    );
  }
});
