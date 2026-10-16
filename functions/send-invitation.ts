import {
  TrustpilotError,
  createInviteContext,
  getOrder,
  getSettings,
  inviteOrder,
  invitationStatus,
  missingSettings,
  swellEnv,
  type TrustpilotSettings,
} from './lib/trustpilot';

export const config: SwellConfig = {
  description: 'Send a Trustpilot invitation for one order',
  action: true,
};

const RECORD_ID = /^[0-9a-f]{24}$/i;

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

async function send(req: SwellRequest, settings: TrustpilotSettings, order: any, force: boolean): Promise<string> {
  try {
    const ctx = await createInviteContext(settings, req.store?.url);
    // sent from the order page: no delay
    const result = await inviteOrder(req.swell, order, ctx, {
      delayDays: 0,
      force,
      appId: req.appId,
      env: swellEnv(req),
    });

    if (result.status === 'sent') {
      return `Invitation sent to ${order.account.email}.`;
    }
    if (result.status === 'failed') {
      fail(`Trustpilot did not accept the invitation: ${result.reason}`);
    }
    if (result.status === 'unconfirmed') {
      fail(
        `Trustpilot didn't confirm the invitation (${result.reason}). It may have been created: ` +
          'check your invitations in Trustpilot Business before sending again.',
      );
    }
    if (result.reason === 'already invited' && invitationStatus(order, req.appId).trustpilot_status === 'unconfirmed') {
      fail(
        "Trustpilot didn't confirm the last invitation for this order. Check your invitations in Trustpilot Business, " +
          'and tick "Send again" only if it isn\'t there.',
      );
    }
    if (result.reason === 'already invited') {
      const sentAt = invitationStatus(order, req.appId).trustpilot_sent_at;
      fail(
        `This order was already invited${sentAt ? ` on ${String(sentAt).slice(0, 10)}` : ''}. Tick "Send again" to send another invitation.`,
      );
    }
    fail(`Not sent: ${result.reason}.`);
  } catch (err) {
    if (err instanceof SwellError) {
      throw err;
    }
    if (err instanceof TrustpilotError && (err.status === 401 || err.status === 403)) {
      fail(
        "Trustpilot rejected the API key or secret, or your plan doesn't include the API module. " +
          'Run Test connection in Apps → Trustpilot.',
      );
    }
    // only temporary failures (network, rate limit, outage) are worth trying again
    const retry = err instanceof TrustpilotError && err.retryable ? ', try again later' : '';
    fail(`Trustpilot request failed${retry}: ${err instanceof Error ? err.message : err}`);
  }
}

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const settings = getSettings(await swell.settings());

  if (!settings.enabled) {
    fail('The Trustpilot app is turned off in its settings.');
  }
  const missing = missingSettings(settings);
  if (missing.length) {
    fail(`Add the ${missing.join(', ')} in Apps → Trustpilot first.`);
  }

  const orderId = String(data.$action?.record_id || '');
  if (!RECORD_ID.test(orderId)) {
    fail('Open an order to run this action');
  }

  const order = await getOrder(swell, orderId);
  const force = data.send_again === true;

  return { message: await send(req, settings, order, force) };
}
