import { swellEnv } from './lib/trustpilot';

export const config: SwellConfig = {
  description: 'Start sending invitations for past or selected orders',
  action: true,
};

// Workflows get no request headers and only the store id, so this action passes what the run needs: the environment
// (Swell-Env, so test orders can be skipped), the storefront URL (product links) and which orders to invite
export default async function (req: SwellRequest) {
  const { data } = req;
  const bulk = data.$action?.source === 'bulk';
  const run = await req.swell.workflows.create('invite-orders', {
    env: swellEnv(req),
    store_url: req.store?.url || null,
    ...(bulk ? { query: data.$action?.selection?.query || null } : { since: data.since || null }),
  });
  console.log(`Trustpilot: started invitations ${run?.id}${swellEnv(req) ? ' (test environment)' : ''}`);
  return { message: 'Invitations started. Follow them in the Workflows tab of the Trustpilot app.' };
}
