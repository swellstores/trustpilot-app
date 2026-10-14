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
  // why the run stopped before the page was sent
  stopped?: string;
}

export default class InviteOrders {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    const data = (req.data || {}) as any;
    // step output is stored with the run, so keep only what the run needs here, never the API key or secret
    const check = await step.do('load settings', async () => {
      const settings = getSettings(await req.swell.settings());
      return { enabled: settings.enabled, missing: missingSettings(settings), invite_on: settings.invite_on };
    });

    // throw so the run ends as failed instead of completed
    if (!check.enabled) {
      console.log('Trustpilot: invitations skipped, the app is disabled in settings');
      throw new Error('Invitations not sent: the Trustpilot app is turned off in its settings.');
    }
    if (check.missing.length) {
      console.error(`Trustpilot: invitations skipped, missing ${check.missing.join(', ')} in app settings`);
      throw new Error(`Invitations not sent: add the ${check.missing.join(', ')} in Apps → Trustpilot.`);
    }

    // orders selected in the list, or past orders since the date in the modal
    const query =
      data.$action?.source === 'bulk' && data.$action.selection?.query
        ? data.$action.selection.query
        : pastOrdersQuery(check.invite_on, parseSince(data.since));

    let totals = emptyStats();
    let lastId: string | null = null;

    for (let page = 1; ; page++) {
      const afterId = lastId;
      const result: PageResult = await step.do(
        `page ${page}`,
        { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } },
        async () => {
          // settings are read in each page so credentials stay out of step output;
          // stop sending if the app was disabled or credentials removed while the run was going
          const settings = getSettings(await req.swell.settings());
          if (!settings.enabled) {
            return { ...emptyStats(), count: 0, last_id: null, stopped: 'the app was turned off in its settings' };
          }
          const missing = missingSettings(settings);
          if (missing.length) {
            const stopped = `the ${missing.join(', ')} ${missing.length > 1 ? 'were' : 'was'} removed from the settings`;
            return { ...emptyStats(), count: 0, last_id: null, stopped };
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

      if (result.stopped) {
        console.log(`Trustpilot: invitations stopped at page ${page}, ${result.stopped}`);
        throw new Error(
          `Invitations stopped: ${result.stopped}. Before stopping: sent ${totals.sent}, skipped ${totals.skipped}, ` +
            `failed ${totals.failed}, not confirmed ${totals.unconfirmed}.`,
        );
      }

      totals = addStats(totals, result);
      lastId = result.last_id;

      if (result.count < PAGE_SIZE || !lastId) {
        break;
      }
    }

    console.log(
      `Trustpilot: invitations finished. Sent: ${totals.sent}, skipped: ${totals.skipped}, ` +
        `failed: ${totals.failed}, not confirmed: ${totals.unconfirmed}`,
    );
    return totals;
  }
}
