import { PAGE_SIZE, addStats, emptyStats, fetchOrders, invitePage, parseSince, pastOrdersQuery, type BatchStats } from './lib/batch';
import { TrustpilotError, createInviteContext, detailOf, getSettings, missingSettings } from './lib/trustpilot';

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

const totalsText = (t: BatchStats) =>
  `sent ${t.sent}, skipped ${t.skipped}, failed ${t.failed}, not confirmed ${t.unconfirmed}`;

// a permanent Trustpilot error as the merchant should read it
export function permanentMessage(err: TrustpilotError): string {
  if (err.status === 401 || err.status === 403) {
    return "Trustpilot rejected the API key or secret, or your plan doesn't include the API module. Run Test connection in Apps → Trustpilot.";
  }
  if (err.status === 404) {
    return `Trustpilot couldn't find ${err.endpoint || 'the business unit'}. Check the Business unit ID.`;
  }
  return `Trustpilot refused ${err.endpoint || 'the request'}: ${err.message.replace(/^Trustpilot \d+: /, '')}`;
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
      const result: PageResult | { error: string } = await step.do(
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
          // step.do retries every thrown error, so permanent Trustpilot errors (bad credentials, wrong business unit)
          // are returned and fail the run right away; network errors, 429 and 5xx are thrown and retried
          try {
            const ctx = await createInviteContext(settings, req.store?.url);
            const stats = await invitePage(req.swell, orders, ctx, req.appId);
            return { ...stats, count: orders.length, last_id: orders[orders.length - 1]?.id ?? null };
          } catch (err) {
            if (err instanceof TrustpilotError && !err.retryable) {
              console.error(`Trustpilot: invitations failed: ${detailOf(err)}`);
              return { error: permanentMessage(err) };
            }
            throw err;
          }
        },
      );

      if ('error' in result) {
        throw new Error(`Invitations failed on page ${page}. ${result.error} Before failing: ${totalsText(totals)}.`);
      }
      if (result.stopped) {
        console.log(`Trustpilot: invitations stopped at page ${page}, ${result.stopped}`);
        throw new Error(`Invitations stopped: ${result.stopped}. Before stopping: ${totalsText(totals)}.`);
      }

      totals = addStats(totals, result);
      lastId = result.last_id;

      if (result.count < PAGE_SIZE || !lastId) {
        break;
      }
    }

    // a run where Trustpilot rejected every invitation it was sent shouldn't look successful
    if (totals.failed && !totals.sent && !totals.unconfirmed) {
      throw new Error(
        `Invitations finished, but Trustpilot rejected all ${totals.failed} invitations it was sent; the reasons are on each order's Trustpilot tab. Totals: ${totalsText(totals)}.`,
      );
    }
    console.log(
      `Trustpilot: invitations finished. Sent: ${totals.sent}, skipped: ${totals.skipped}, ` +
        `failed: ${totals.failed}, not confirmed: ${totals.unconfirmed}`,
    );
    return totals;
  }
}
