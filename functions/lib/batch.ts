import { invitationStatus, inviteOrder, type InviteContext, type InviteOn, type SwellClient } from './trustpilot';

// orders loaded per workflow step
export const PAGE_SIZE = 50;

// parallel Trustpilot calls within a page
const CONCURRENCY = 5;

const ORDER_EXPAND = ['account', 'items.product', 'items.variant'];

export interface BatchStats {
  sent: number;
  skipped: number;
  failed: number;
  // Trustpilot didn't answer; the invitation may or may not exist
  unconfirmed: number;
}

export function emptyStats(): BatchStats {
  return { sent: 0, skipped: 0, failed: 0, unconfirmed: 0 };
}

export function addStats(total: BatchStats, page: BatchStats): BatchStats {
  return {
    sent: total.sent + page.sent,
    skipped: total.skipped + page.skipped,
    failed: total.failed + page.failed,
    unconfirmed: total.unconfirmed + page.unconfirmed,
  };
}

// filter for orders that reached the "Send invitation when" state
export function stateFilter(inviteOn: InviteOn): Record<string, any> {
  if (inviteOn === 'delivered') return { delivered: true };
  if (inviteOn === 'paid') return { paid: true };
  return { draft: { $ne: true } };
}

// past orders created on or after `since` (YYYY-MM-DD) that reached the invite state
export function pastOrdersQuery(inviteOn: InviteOn, since: string): Record<string, any> {
  return {
    $and: [stateFilter(inviteOn), { canceled: { $ne: true } }, { date_created: { $gte: since } }],
  };
}

// valid `since` date from the action modal, or `days` ago
export function parseSince(value: unknown, days = 30, now = new Date()): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// next page of orders after the given id, oldest first; appends to the query's $and
export async function fetchOrders(
  swell: Pick<SwellClient, 'get'>,
  query: Record<string, any>,
  afterId: string | null,
  limit = PAGE_SIZE,
): Promise<any[]> {
  const conditions = [...(query.$and || [])];
  if (afterId) {
    conditions.push({ id: { $gt: afterId } });
  }
  const page = await swell.get('/orders', {
    ...query,
    ...(conditions.length ? { $and: conditions } : {}),
    sort: 'id asc',
    limit,
    expand: ORDER_EXPAND,
  });
  return page?.results || [];
}

// invite a page of orders; a rate limit is rethrown so the workflow retries the page. `runStartedAt` (ISO time) counts
// orders this run already invited, before a retried page's error, as sent instead of skipped
export async function invitePage(
  swell: SwellClient,
  orders: any[],
  ctx: InviteContext,
  appId?: string,
  options: { env?: string | null; runStartedAt?: string } = {},
): Promise<BatchStats> {
  const stats = emptyStats();
  for (let i = 0; i < orders.length; i += CONCURRENCY) {
    const batch = orders.slice(i, i + CONCURRENCY);
    // past orders are sent right away, without the delay
    const results = await Promise.allSettled(
      batch.map((order) => inviteOrder(swell, order, ctx, { delayDays: 0, appId, env: options.env })),
    );
    results.forEach((result, index) => {
      // inviteOrder records each result itself; what reaches here is a Trustpilot rate limit (nothing was created)
      // or an error before any invitation was sent, so retry the page: invited orders are skipped on the retry
      if (result.status === 'rejected') {
        throw result.reason;
      }
      stats[sentThisRun(batch[index], result.value, appId, options.runStartedAt) ? 'sent' : result.value.status]++;
    });
  }
  return stats;
}

// an order skipped as already invited that this run itself invited, before the page was retried
function sentThisRun(order: any, result: { status: string; reason?: string }, appId?: string, runStartedAt?: string): boolean {
  if (!runStartedAt || result.status !== 'skipped' || result.reason !== 'already invited') return false;
  const saved = invitationStatus(order, appId);
  return saved.trustpilot_status === 'sent' && typeof saved.trustpilot_sent_at === 'string' && saved.trustpilot_sent_at >= runStartedAt;
}
