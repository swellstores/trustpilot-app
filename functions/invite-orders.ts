import { PAGE_SIZE, addStats, emptyStats, fetchOrders, invitePage, parseSince, pastOrdersQuery, type BatchStats } from './lib/batch';
import { createInviteContext, getSettings, missingSettings } from './lib/trustpilot';

export const config: SwellConfig = {
  kind: 'workflow',
  description: 'Send Trustpilot invitations for past or selected orders',
  action: true,
};

interface PageResult extends BatchStats {
  count: number;
  last_id: string | null;
  // set when the app was disabled before the page was sent
  disabled?: boolean;
}

export default class InviteOrders {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    const data = (req.data || {}) as any;
    const rawSettings = await step.do('load settings', async () => req.swell.settings());
    const settings = getSettings(rawSettings);

    if (!settings.enabled) {
      console.log('Trustpilot: invitations skipped, the app is disabled in settings');
      return { error: 'disabled' };
    }
    const missing = missingSettings(settings);
    if (missing.length) {
      console.error(`Trustpilot: invitations skipped, missing ${missing.join(', ')} in app settings`);
      return { error: 'missing_settings' };
    }

    // orders selected in the list, or past orders since the date in the modal
    const query =
      data.$action?.source === 'bulk' && data.$action.selection?.query
        ? data.$action.selection.query
        : pastOrdersQuery(settings.invite_on, parseSince(data.since));

    let totals = emptyStats();
    let lastId: string | null = null;

    for (let page = 1; ; page++) {
      const afterId = lastId;
      const result: PageResult = await step.do(
        `page ${page}`,
        { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
        async () => {
          // stop sending if the app was disabled while the run was going
          if (!getSettings(await req.swell.settings()).enabled) {
            return { ...emptyStats(), count: 0, last_id: null, disabled: true };
          }
          const orders = await fetchOrders(req.swell, query, afterId);
          if (!orders.length) {
            return { ...emptyStats(), count: 0, last_id: null };
          }
          const ctx = await createInviteContext(settings, req.store?.url);
          const stats = await invitePage(req.swell, orders, ctx, req.appId);
          return { ...stats, count: orders.length, last_id: orders[orders.length - 1]?.id ?? null };
        },
      );

      if (result.disabled) {
        console.log(`Trustpilot: invitations stopped at page ${page}, the app was disabled in settings`);
        return { ...totals, error: 'disabled' };
      }

      totals = addStats(totals, result);
      lastId = result.last_id;

      if (result.count < PAGE_SIZE || !lastId) {
        break;
      }
    }

    console.log(
      `Trustpilot: invitations finished. Sent: ${totals.sent}, skipped: ${totals.skipped}, failed: ${totals.failed}`,
    );
    return totals;
  }
}
