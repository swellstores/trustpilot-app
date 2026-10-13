import { inviteOrder, type InviteContext, type InviteOn, type SwellClient } from './trustpilot';

// orders loaded per workflow step
export const PAGE_SIZE = 50;

// parallel Trustpilot calls within a page
const CONCURRENCY = 5;

const ORDER_EXPAND = ['account', 'items.product', 'items.variant'];

export interface BatchStats {
  sent: number;
  skipped: number;
  failed: number;
}

export function emptyStats(): BatchStats {
  return { sent: 0, skipped: 0, failed: 0 };
}

export function addStats(total: BatchStats, page: BatchStats): BatchStats {
  return {
    sent: total.sent + page.sent,
    skipped: total.skipped + page.skipped,
    failed: total.failed + page.failed,
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

// invite a page of orders; retryable errors are rethrown so the workflow retries the page
export async function invitePage(
  swell: SwellClient,
  orders: any[],
  ctx: InviteContext,
  appId?: string,
): Promise<BatchStats> {
  const stats = emptyStats();
  for (let i = 0; i < orders.length; i += CONCURRENCY) {
    const batch = orders.slice(i, i + CONCURRENCY);
    // past orders are sent right away, without the delay
    const results = await Promise.allSettled(
      batch.map((order) => inviteOrder(swell, order, ctx, { delayDays: 0, appId })),
    );
    for (const result of results) {
      // inviteOrder records Trustpilot rejections itself; what reaches here is retryable
      // (Trustpilot rate limit or outage) or a failed Swell update, so retry the page
      if (result.status === 'rejected') {
        throw result.reason;
      }
      stats[result.value.status]++;
    }
  }
  return stats;
}
