import {
  TrustpilotError,
  findBusinessUnit,
  getAccessToken,
  getBusinessUnit,
  getSettings,
  getTemplates,
  storeDomain,
  type TrustpilotSettings,
} from './lib/trustpilot';

export const config: SwellConfig = {
  description: 'Check the Trustpilot credentials and business unit',
  action: true,
};

function describeTemplates(templates: any[]): string {
  if (!templates.length) {
    return 'No invitation templates found.';
  }
  const list = templates
    .map((t) => `${t.name} (${t.locale}${t.isDefaultTemplate ? ', default' : ''}) = ${t.id}`)
    .join('; ');
  return `Templates: ${list}.`;
}

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

async function check(settings: TrustpilotSettings, storeUrl: string | undefined): Promise<string> {
  if (!settings.business_unit_id) {
    const domain = storeDomain(storeUrl);
    if (!domain) {
      fail('Enter your Business unit ID, then save the settings.');
    }
    try {
      const unit = await findBusinessUnit(settings.api_key, domain);
      return `Found ${unit?.displayName || domain} for ${domain}. Business unit ID: ${unit?.id}. Enter it in the settings and save.`;
    } catch (err) {
      if (err instanceof TrustpilotError && err.status === 404) {
        fail(`No Trustpilot business unit found for ${domain}. Enter your Business unit ID, then save the settings.`);
      }
      throw err;
    }
  }

  let unit: any;
  try {
    unit = await getBusinessUnit(settings.api_key, settings.business_unit_id);
  } catch (err) {
    // only a 404 from the business unit lookup means a wrong ID; a 404 elsewhere is reported as it is
    if (err instanceof TrustpilotError && err.status === 404) {
      fail(`Business unit ${settings.business_unit_id} was not found in Trustpilot. Check the ID.`);
    }
    throw err;
  }
  // business names such as "Alder & Co." already end with a period
  const name = String(unit?.displayName || settings.business_unit_id).replace(/\.+$/, '');
  const notes = [`Connected to ${name}.`];
  if (unit?.score?.trustScore !== undefined) {
    notes.push(`TrustScore ${unit.score.trustScore} from ${unit?.numberOfReviews?.total ?? 0} reviews.`);
  }

  const token = await getAccessToken(settings);
  notes.push(describeTemplates(await getTemplates(settings, token)));
  return notes.join(' ');
}

export default async function (req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());

  if (!settings.api_key || !settings.api_secret) {
    fail('Add your Trustpilot API key and secret and save the settings first.');
  }

  let message: string;
  try {
    message = await check(settings, req.store?.url);
  } catch (err) {
    if (err instanceof SwellError) {
      throw err;
    }
    if (err instanceof TrustpilotError && (err.status === 401 || err.status === 403)) {
      fail(
        'Trustpilot rejected the API key or secret. Check them in Trustpilot Business → Integrations → Developers → APIs, ' +
          'and that your Trustpilot plan includes the API module (not available on the free plan).',
      );
    }
    const retry = err instanceof TrustpilotError && err.retryable ? ', try again later' : '';
    fail(`Trustpilot request failed${retry}: ${err instanceof Error ? err.message : err}`);
  }
  return {
    message: settings.enabled
      ? message
      : `${message} The app is turned off, so no invitations are sent until you turn it on.`,
  };
}
