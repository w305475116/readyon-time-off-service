import { Buffer } from 'buffer';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

type Filing = {
  requestId: string;
  employeeId: string;
  locationId: string;
  requestedDays: number;
  hcmReferenceId: string;
  availableDays: number;
};

type BalanceBehavior = 'normal' | 'server-error';
type FileBehavior = 'normal' | 'socket-close-after-filing' | 'server-error';

export class MockHcmServer {
  private server?: Server;
  private balances = new Map<string, number>();
  private filings = new Map<string, Filing>();
  private balanceBehavior: BalanceBehavior = 'normal';
  private fileBehavior: FileBehavior = 'normal';

  baseUrl = '';
  filePostCalls = 0;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });

    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => {
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
  }

  reset(): void {
    this.balances.clear();
    this.filings.clear();
    this.balanceBehavior = 'normal';
    this.fileBehavior = 'normal';
    this.filePostCalls = 0;
  }

  setBalance(employeeId: string, locationId: string, availableDays: number): void {
    this.balances.set(this.balanceKey(employeeId, locationId), availableDays);
  }

  deleteBalance(employeeId: string, locationId: string): void {
    this.balances.delete(this.balanceKey(employeeId, locationId));
  }

  setBalanceBehavior(behavior: BalanceBehavior): void {
    this.balanceBehavior = behavior;
  }

  setFileBehavior(behavior: FileBehavior): void {
    this.fileBehavior = behavior;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl);

    if (request.method === 'GET' && url.pathname === '/hcm/balances') {
      this.handleGetBalance(url, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/hcm/time-off-filings') {
      await this.handleFileTimeOff(request, response);
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/hcm/time-off-filings/')) {
      this.handleGetFiling(url, response);
      return;
    }

    this.respondJson(response, 404, {
      code: 'NOT_FOUND',
      message: 'Mock HCM route not found.'
    });
  }

  private handleGetBalance(url: URL, response: ServerResponse): void {
    if (this.balanceBehavior === 'server-error') {
      this.respondJson(response, 500, {
        code: 'HCM_INTERNAL_ERROR',
        message: 'HCM balance API failed.'
      });
      return;
    }

    const employeeId = url.searchParams.get('employeeId') ?? '';
    const locationId = url.searchParams.get('locationId') ?? '';
    const availableDays = this.balances.get(this.balanceKey(employeeId, locationId));

    if (availableDays === undefined) {
      this.respondJson(response, 400, {
        code: 'HCM_INVALID_DIMENSIONS',
        message: 'Invalid employee/location dimensions.'
      });
      return;
    }

    this.respondJson(response, 200, {
      employeeId,
      locationId,
      availableDays
    });
  }

  private async handleFileTimeOff(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.filePostCalls += 1;

    if (this.fileBehavior === 'server-error') {
      this.respondJson(response, 500, {
        code: 'HCM_INTERNAL_ERROR',
        message: 'HCM filing API failed.'
      });
      return;
    }

    const body = await this.readJson(request);
    const requestId = this.asString(body.requestId);
    const employeeId = this.asString(body.employeeId);
    const locationId = this.asString(body.locationId);
    const requestedDays = this.asNumber(body.requestedDays);

    const existing = this.filings.get(requestId);
    if (existing) {
      this.respondJson(response, 200, {
        hcmReferenceId: existing.hcmReferenceId,
        availableDays: existing.availableDays
      });
      return;
    }

    const balanceKey = this.balanceKey(employeeId, locationId);
    const availableDays = this.balances.get(balanceKey);
    if (availableDays === undefined) {
      this.respondJson(response, 400, {
        code: 'HCM_INVALID_DIMENSIONS',
        message: 'Invalid employee/location dimensions.'
      });
      return;
    }

    if (availableDays < requestedDays) {
      this.respondJson(response, 409, {
        code: 'HCM_INSUFFICIENT_BALANCE',
        message: 'Insufficient balance.'
      });
      return;
    }

    const remaining = availableDays - requestedDays;
    const filing: Filing = {
      requestId,
      employeeId,
      locationId,
      requestedDays,
      availableDays: remaining,
      hcmReferenceId: `hcm_${requestId}`
    };

    this.balances.set(balanceKey, remaining);
    this.filings.set(requestId, filing);

    if (this.fileBehavior === 'socket-close-after-filing') {
      response.socket?.destroy();
      return;
    }

    this.respondJson(response, 200, {
      hcmReferenceId: filing.hcmReferenceId,
      availableDays: remaining
    });
  }

  private handleGetFiling(url: URL, response: ServerResponse): void {
    const requestId = url.pathname.split('/').at(-1) ?? '';
    const filing = this.filings.get(requestId);

    if (!filing) {
      this.respondJson(response, 200, { status: 'NOT_FOUND' });
      return;
    }

    this.respondJson(response, 200, {
      status: 'FILED',
      hcmReferenceId: filing.hcmReferenceId,
      availableDays: filing.availableDays
    });
  }

  private readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      });
    });
  }

  private respondJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private asNumber(value: unknown): number {
    return typeof value === 'number' ? value : Number(value);
  }

  private balanceKey(employeeId: string, locationId: string): string {
    return `${employeeId}:${locationId}`;
  }
}
