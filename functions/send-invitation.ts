import {
  TrustpilotError,
  createInviteContext,
  getOrder,
  getSettings,
  inviteOrder,
  invitationStatus,
  missingSettings,
} from './lib/trustpilot';

export const config: SwellConfig = {
  description: 'Send a Trustpilot invitation for one order',
  action: true,
};

const RECORD_ID = /^[0-9a-f]{24}$/i;

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const settings = getSettings(await swell.settings());

  if (!settings.enabled) {
    return { message: 'The Trustpilot app is turned off in its settings.' };
  }
  const missing = missingSettings(settings);
  if (missing.length) {
    return { message: `Add the ${missing.join(', ')} in Apps → Trustpilot first.` };
  }

  const orderId = String(data.$action?.record_id || '');
  if (!RECORD_ID.test(orderId)) {
    throw new SwellError('Open an order to run this action', { status: 400 });
  }

  const order = await getOrder(swell, orderId);
  const force = data.send_again === true;

  try {
    const ctx = await createInviteContext(settings, req.store?.url);
    // sent from the order page: no delay
    const result = await inviteOrder(swell, order, ctx, {
      delayDays: 0,
      force,
      appId: req.appId,
    });

    if (result.status === 'sent') {
      return { message: `Invitation sent to ${order.account.email}.` };
    }
    if (result.status === 'failed') {
      return { message: `Trustpilot did not accept the invitation: ${result.reason}` };
    }
    if (result.status === 'unconfirmed') {
      return {
        message:
          `Trustpilot didn't confirm the invitation (${result.reason}). It may have been created: ` +
          'check Trustpilot Business → Invitations before sending again.',
      };
    }
    if (result.reason === 'already invited' && invitationStatus(order, req.appId).trustpilot_status === 'unconfirmed') {
      return {
        message:
          "Trustpilot didn't confirm the last invitation for this order. Check Trustpilot Business → Invitations, " +
          'and tick "Send again" only if it isn\'t there.',
      };
    }
    if (result.reason === 'already invited') {
      const sentAt = invitationStatus(order, req.appId).trustpilot_sent_at;
      return {
        message: `This order was already invited${sentAt ? ` on ${String(sentAt).slice(0, 10)}` : ''}. Tick "Send again" to send another invitation.`,
      };
    }
    return { message: `Not sent: ${result.reason}.` };
  } catch (err) {
    if (err instanceof TrustpilotError && (err.status === 401 || err.status === 403)) {
      return { message: 'Trustpilot rejected the API key or secret. Run Test connection in Apps → Trustpilot.' };
    }
    // only temporary failures (network, rate limit, outage) are worth trying again
    const retry = err instanceof TrustpilotError && err.retryable ? ', try again later' : '';
    return { message: `Trustpilot request failed${retry}: ${err instanceof Error ? err.message : err}` };
  }
}
