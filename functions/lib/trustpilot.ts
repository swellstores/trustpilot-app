const API_BASE = 'https://api.trustpilot.com/v1';
const INVITATIONS_BASE = 'https://invitations-api.trustpilot.com/v1';
const TOKEN_URL = `${API_BASE}/oauth/oauth-business-users-for-applications/accesstoken`;

export type InviteOn = 'delivered' | 'paid' | 'submitted';

export const APP_ID = 'trustpilot';

// the parts of the Swell client the app uses; functions and workflows both provide them
export interface SwellClient {
  get(path: string, data?: any): Promise<any>;
  put(path: string, data?: any): Promise<any>;
  settings(): Promise<any>;
}

// values stored on a standard record under $app.<app id>
export function appValues(values: Record<string, any>, appId = APP_ID): { $app: Record<string, any> } {
  return { $app: { [appId]: values } };
}

export interface TrustpilotSettings {
  api_key: string;
  api_secret: string;
  business_unit_id: string;
  enabled: boolean;
  invite_on: InviteOn;
  delay_days: number;
  locale: string;
  sender_name: string;
  reply_to: string;
  service_template_id: string;
  tags: string[];
  redirect_uri: string;
  product_reviews: boolean;
  product_template_id: string;
  product_url: string;
}

// Error returned by the Trustpilot API (or a network failure when status is 0)
export class TrustpilotError extends Error {
  status: number;
  // the call Trustpilot refused, e.g. "POST /v1/private/business-units/{id}/email-invitations" (no query string)
  endpoint: string | undefined;

  constructor(status: number, message: string, endpoint?: string) {
    super(`Trustpilot ${status}: ${message}`);
    this.name = 'TrustpilotError';
    this.status = status;
    this.endpoint = endpoint;
  }

  // message with the refused call, for logs and workflow errors
  get detail(): string {
    return this.endpoint ? `${this.message} (${this.endpoint})` : this.message;
  }

  // network errors, rate limits and server errors are worth retrying
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

// Swell order event → the invite_on setting it belongs to
export const INVITE_EVENTS: Record<string, InviteOn> = {
  'order.delivered': 'delivered',
  'order.paid': 'paid',
  'order.submitted': 'submitted',
};

const INVITE_ON_VALUES: InviteOn[] = ['delivered', 'paid', 'submitted'];

// read app settings and apply defaults for values the merchant has not saved yet
export function getSettings(all: any): TrustpilotSettings {
  const raw = all?.trustpilot || {};
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const text = (value: unknown, fallback = '') =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const delay = Number(raw.delay_days);

  return {
    api_key: text(raw.api_key),
    api_secret: text(raw.api_secret),
    business_unit_id: text(raw.business_unit_id),
    enabled: flag(raw.enabled, true),
    invite_on: INVITE_ON_VALUES.includes(raw.invite_on) ? raw.invite_on : 'delivered',
    delay_days: Number.isFinite(delay) && delay >= 0 ? Math.min(Math.floor(delay), 90) : 3,
    locale: text(raw.locale, 'en-US'),
    sender_name: text(raw.sender_name),
    reply_to: text(raw.reply_to),
    service_template_id: text(raw.service_template_id),
    tags: parseTags(raw.tags),
    redirect_uri: text(raw.redirect_uri),
    product_reviews: flag(raw.product_reviews, false),
    product_template_id: text(raw.product_template_id),
    product_url: text(raw.product_url),
  };
}

// comma-separated tags → trimmed, non-empty list
export function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((tag) => String(tag).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

// the credentials and business unit the app needs before it can send invitations
export function missingSettings(settings: TrustpilotSettings): string[] {
  const missing: string[] = [];
  if (!settings.api_key) missing.push('API key');
  if (!settings.api_secret) missing.push('API secret');
  if (!settings.business_unit_id) missing.push('Business unit ID');
  return missing;
}

// load settings and check the app can send invitations
export async function loadSettings(swell: SwellClient): Promise<TrustpilotSettings | null> {
  const settings = getSettings(await swell.settings());
  if (!settings.enabled) {
    return null;
  }
  const missing = missingSettings(settings);
  if (missing.length) {
    console.error(`Trustpilot: missing ${missing.join(', ')} in app settings`);
    return null;
  }
  return settings;
}

// call the Trustpilot API; returns parsed JSON or null for empty responses
export async function trustpilotRequest(url: string, init: RequestInit): Promise<any> {
  const endpoint = `${init.method || 'GET'} ${new URL(url).pathname}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err: any) {
    throw new TrustpilotError(0, err?.message || String(err), endpoint);
  }

  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const message = json?.message || json?.details || json?.error_description || json?.error || text || res.statusText;
    throw new TrustpilotError(res.status, typeof message === 'string' ? message : JSON.stringify(message), endpoint);
  }

  return json;
}

// business user access token with the client credentials grant (valid ~100 hours, not refreshable)
export async function getAccessToken(settings: TrustpilotSettings): Promise<string> {
  const json = await trustpilotRequest(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${settings.api_key}:${settings.api_secret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!json?.access_token) {
    throw new TrustpilotError(500, 'no access token in response');
  }
  return json.access_token;
}

// invitation templates of the business unit
export async function getTemplates(settings: TrustpilotSettings, token: string): Promise<any[]> {
  const json = await trustpilotRequest(
    `${INVITATIONS_BASE}/private/business-units/${encodeURIComponent(settings.business_unit_id)}/templates`,
    { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
  );
  return json?.templates || [];
}

// public business unit info (name, TrustScore, review count)
export async function getBusinessUnit(apiKey: string, businessUnitId: string): Promise<any> {
  return trustpilotRequest(`${API_BASE}/business-units/${encodeURIComponent(businessUnitId)}`, {
    method: 'GET',
    headers: { apikey: apiKey, accept: 'application/json' },
  });
}

// website domain of the store, used to look up the business unit
export function storeDomain(url: string | undefined): string {
  if (!url) {
    return '';
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// find a business unit by its website domain
export async function findBusinessUnit(apiKey: string, domain: string): Promise<any> {
  return trustpilotRequest(`${API_BASE}/business-units/find?name=${encodeURIComponent(domain)}`, {
    method: 'GET',
    headers: { apikey: apiKey, accept: 'application/json' },
  });
}

// template id from settings, or the business unit's default template of that kind
export function pickTemplate(templates: any[], kind: 'service' | 'product', configured: string, locale: string) {
  if (configured) {
    return configured;
  }
  const ofKind = templates.filter((t) =>
    kind === 'product' ? /product/i.test(t?.type || '') : !/product/i.test(t?.type || ''),
  );
  const defaults = ofKind.filter((t) => t?.isDefaultTemplate);
  const match =
    defaults.find((t) => t.locale?.toLowerCase() === locale.toLowerCase()) ||
    defaults[0] ||
    ofKind.find((t) => t.locale?.toLowerCase() === locale.toLowerCase());
  return match?.id as string | undefined;
}

// everything needed to send invitations: token and resolved template ids
export interface InviteContext {
  settings: TrustpilotSettings;
  token: string;
  serviceTemplateId?: string;
  productTemplateId?: string;
  storeUrl: string;
}

export async function createInviteContext(settings: TrustpilotSettings, storeUrl = ''): Promise<InviteContext> {
  const token = await getAccessToken(settings);
  let serviceTemplateId = settings.service_template_id || undefined;
  let productTemplateId = settings.product_template_id || undefined;

  // only look up templates when one of them is not configured
  if (!serviceTemplateId || (settings.product_reviews && !productTemplateId)) {
    const templates = await getTemplates(settings, token);
    serviceTemplateId = pickTemplate(templates, 'service', settings.service_template_id, settings.locale);
    productTemplateId = pickTemplate(templates, 'product', settings.product_template_id, settings.locale);
  }

  return { settings, token, serviceTemplateId, productTemplateId, storeUrl: storeUrl.replace(/\/+$/, '') };
}

// customer name for the invitation: billing, account, then the email's local part
export function consumerName(order: any): string {
  const fromParts = (o: any) => [o?.first_name, o?.last_name].filter(Boolean).join(' ');
  return (
    order?.billing?.name ||
    fromParts(order?.billing) ||
    order?.account?.name ||
    fromParts(order?.account) ||
    order?.shipping?.name ||
    String(order?.account?.email || '').split('@')[0]
  ).trim();
}

// storefront product page URL from the template ({slug}, {id}) or <store url>/products/<slug>
export function productUrl(product: any, template: string, storeUrl: string): string | undefined {
  if (!product?.slug && !product?.id) {
    return undefined;
  }
  if (template) {
    // leave the URL out rather than send one with an empty placeholder
    if ((template.includes('{slug}') && !product.slug) || (template.includes('{id}') && !product.id)) {
      return undefined;
    }
    return template.replace(/\{slug\}/g, product.slug).replace(/\{id\}/g, product.id);
  }
  return storeUrl && product.slug ? `${storeUrl}/products/${product.slug}` : undefined;
}

// remove empty values so Trustpilot gets a compact payload
function compact<T extends Record<string, any>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Partial<T>;
}

// order items as Trustpilot products; items without a SKU or name are left out, one entry per SKU
export function buildProducts(order: any, ctx: InviteContext): object[] {
  const seen = new Set<string>();
  const products: object[] = [];
  for (const item of order?.items || []) {
    const sku = item.variant?.sku || item.product?.sku;
    const name = item.product?.name;
    if (!sku || !name || seen.has(sku)) {
      continue;
    }
    seen.add(sku);
    products.push(
      compact({
        sku,
        name,
        brand: item.product?.brand,
        imageUrl: item.variant?.images?.[0]?.file?.url || item.product?.images?.[0]?.file?.url,
        productUrl: productUrl(item.product, ctx.settings.product_url, ctx.storeUrl),
      }),
    );
  }
  return products;
}

// time the invitation should go out, or undefined to send right away
export function sendTime(delayDays: number, now = new Date()): string | undefined {
  if (!delayDays) {
    return undefined;
  }
  return new Date(now.getTime() + delayDays * 24 * 60 * 60 * 1000).toISOString();
}

// Trustpilot email invitation payload for a Swell order
export function buildInvitation(order: any, ctx: InviteContext, delayDays: number, now = new Date()): any {
  const { settings } = ctx;
  const preferredSendTime = sendTime(delayDays, now);

  const payload: any = compact({
    consumerEmail: order.account?.email,
    consumerName: consumerName(order),
    referenceNumber: String(order.number || order.id),
    locale: settings.locale,
    senderName: settings.sender_name,
    replyTo: settings.reply_to,
    type: 'email',
  });

  payload.serviceReviewInvitation = compact({
    templateId: ctx.serviceTemplateId,
    preferredSendTime,
    redirectUri: settings.redirect_uri,
    tags: settings.tags.length ? settings.tags : undefined,
  });

  if (settings.product_reviews) {
    const products = buildProducts(order, ctx);
    if (products.length) {
      payload.productReviewInvitation = compact({
        templateId: ctx.productTemplateId,
        preferredSendTime,
        redirectUri: settings.redirect_uri,
        products,
      });
    }
  }

  return payload;
}

// why an order can't be invited, or null when it can
export function skipReason(order: any): string | null {
  if (!order) return 'order not found';
  if (order.canceled) return 'order is canceled';
  if (order.draft) return 'order is a draft';
  if (!order.account?.email) return 'order has no customer email';
  return null;
}

// app values stored on the order
export function invitationStatus(order: any, appId = APP_ID): any {
  return order?.$app?.[appId] || {};
}

// sent, or unconfirmed: Trustpilot may have created it, so sending again could email the customer twice
export function alreadyInvited(order: any, appId = APP_ID): boolean {
  const status = invitationStatus(order, appId).trustpilot_status;
  return status === 'sent' || status === 'unconfirmed';
}

export interface InviteResult {
  status: 'sent' | 'skipped' | 'failed' | 'unconfirmed';
  reason?: string;
}

// save the invitation result on the order; a failed save is logged, not thrown, so the
// invitation is never sent again just because the order couldn't be updated
async function recordResult(swell: SwellClient, order: any, values: Record<string, any>, appId?: string) {
  try {
    await swell.put(`/orders/${order.id}`, appValues(values, appId));
  } catch (err) {
    console.error(
      `Trustpilot: invitation result for order ${order.number || order.id} not saved (${values.trustpilot_status}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

// send the invitation and record the result on the order; only a rate limit is rethrown for a retry
export async function inviteOrder(
  swell: SwellClient,
  order: any,
  ctx: InviteContext,
  options: { delayDays: number; force?: boolean; appId?: string },
): Promise<InviteResult> {
  const reason = skipReason(order);
  if (reason) {
    return { status: 'skipped', reason };
  }
  if (!options.force && alreadyInvited(order, options.appId)) {
    return { status: 'skipped', reason: 'already invited' };
  }

  const payload = buildInvitation(order, ctx, options.delayDays);
  const url = `${INVITATIONS_BASE}/private/business-units/${encodeURIComponent(ctx.settings.business_unit_id)}/email-invitations`;

  try {
    await trustpilotRequest(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // a rate limit is rejected before the invitation is created, so it is safe to retry
    if (err instanceof TrustpilotError && err.status === 429) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    // after a network error, timeout or 5xx Trustpilot may already have created the invitation:
    // record it as unconfirmed and don't retry, so the customer isn't emailed twice
    if (err instanceof TrustpilotError && err.retryable) {
      const note = `${message}. Trustpilot may have created the invitation: check Trustpilot Business → Invitations before sending again.`;
      await recordResult(swell, order, { trustpilot_status: 'unconfirmed', trustpilot_error: note }, options.appId);
      console.error(`Trustpilot: invitation for order ${order.number || order.id} not confirmed, not retried: ${detailOf(err)}`);
      return { status: 'unconfirmed', reason: message };
    }
    await recordResult(swell, order, { trustpilot_status: 'failed', trustpilot_error: message }, options.appId);
    console.error(`Trustpilot: invitation for order ${order.number || order.id} failed: ${detailOf(err)}`);
    return { status: 'failed', reason: message };
  }

  const now = new Date().toISOString();
  await recordResult(
    swell,
    order,
    {
      trustpilot_status: 'sent',
      trustpilot_sent_at: now,
      trustpilot_send_time: payload.serviceReviewInvitation?.preferredSendTime || now,
      trustpilot_error: null,
    },
    options.appId,
  );
  console.log(`Trustpilot: invitation for order ${order.number || order.id} sent to ${order.account.email}`);
  return { status: 'sent' };
}

// load an order with what the invitation needs
export async function getOrder(swell: SwellClient, id: string): Promise<any> {
  return swell.get('/orders/{id}', { id, expand: ['account', 'items.product', 'items.variant'] });
}

// error message with the refused call when it's a Trustpilot error
export function detailOf(err: unknown): string {
  if (err instanceof TrustpilotError) return err.detail;
  return err instanceof Error ? err.message : String(err);
}

// rethrow errors Swell should retry, log the rest
export function handleError(label: string, err: unknown): void {
  if (err instanceof TrustpilotError && err.retryable) {
    throw err;
  }
  console.error(`Trustpilot: ${label} failed: ${detailOf(err)}`);
}
