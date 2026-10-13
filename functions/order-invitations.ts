import { INVITE_EVENTS, createInviteContext, getOrder, handleError, inviteOrder, loadSettings } from './lib/trustpilot';

export const config: SwellConfig = {
  description: 'Send Trustpilot review invitations for orders',
  model: {
    events: ['order.submitted', 'order.paid', 'order.delivered'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const eventType = data.$event?.type;

  const settings = await loadSettings(swell);
  if (!settings) {
    return;
  }

  // only the event chosen in "Send invitation when" sends invitations
  if (!eventType || INVITE_EVENTS[eventType] !== settings.invite_on) {
    return;
  }

  const order = await getOrder(swell, data.id);
  if (!order) {
    console.error(`Trustpilot: order ${data.id} not found`);
    return;
  }

  try {
    const ctx = await createInviteContext(settings, req.store?.url);
    const result = await inviteOrder(swell, order, ctx, {
      delayDays: settings.delay_days,
      appId: req.appId,
    });
    if (result.status === 'skipped') {
      console.log(`Trustpilot: order ${order.number || order.id} skipped, ${result.reason}`);
    }
  } catch (err) {
    handleError(`invitation for order ${data.id}`, err);
  }
}
