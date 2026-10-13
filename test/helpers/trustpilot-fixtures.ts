import { vi } from "vitest";
import { getSettings, type InviteContext, type TrustpilotSettings } from "../../functions/lib/trustpilot";

// raw settings as returned by swell.settings()
export const rawSettings = {
  api_key: "tp-key",
  api_secret: "tp-secret",
  business_unit_id: "bu_1",
};

export function makeSettings(overrides: Partial<TrustpilotSettings> = {}): TrustpilotSettings {
  return { ...getSettings({ trustpilot: rawSettings }), ...overrides };
}

export function makeContext(overrides: Partial<InviteContext> = {}): InviteContext {
  return {
    settings: makeSettings(),
    token: "token_1",
    serviceTemplateId: "tpl_service",
    productTemplateId: "tpl_product",
    storeUrl: "https://shop.example.com",
    ...overrides,
  };
}

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: "64b7f0c2a1b2c3d4e5f60718",
    number: "100001",
    status: "delivered",
    delivered: true,
    paid: true,
    canceled: false,
    billing: { name: "Jane Doe" },
    account: { id: "acc_1", email: "jane@example.com", first_name: "Jane", last_name: "Doe" },
    items: [
      {
        id: "item_1",
        product_id: "prod_1",
        quantity: 1,
        product: {
          id: "prod_1",
          slug: "trail-shirt",
          name: "Trail Shirt",
          sku: "SKU-P",
          brand: "Alder",
          images: [{ file: { url: "https://cdn/p.jpg" } }],
        },
        variant: { sku: "SKU-V", images: [{ file: { url: "https://cdn/v.jpg" } }] },
      },
    ],
    ...overrides,
  };
}

export const templates = [
  { id: "tpl_default_en", name: "Default", locale: "en-US", isDefaultTemplate: true, type: "ServiceReview" },
  { id: "tpl_other", name: "Other", locale: "en-US", isDefaultTemplate: false, type: "ServiceReview" },
  { id: "tpl_product_en", name: "Products", locale: "en-US", isDefaultTemplate: true, type: "ProductReview" },
];

type Reply = { status: number; body?: any } | Error;

export interface Routes {
  token?: Reply;
  templates?: Reply;
  invite?: Reply | Reply[];
  unit?: Reply;
  find?: Reply;
}

function respond(reply: Reply): Response {
  if (reply instanceof Error) {
    throw reply;
  }
  const text = reply.body === undefined ? null : JSON.stringify(reply.body);
  return new Response(text, { status: reply.status });
}

// Mocks global fetch by Trustpilot endpoint; invite replies are taken in order (the last one repeats)
export function mockTrustpilot(routes: Routes = {}) {
  const invites = Array.isArray(routes.invite) ? [...routes.invite] : [routes.invite ?? { status: 202, body: {} }];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input);
    if (url.includes("/oauth/")) {
      return respond(routes.token ?? { status: 200, body: { access_token: "token_1", expires_in: "359999" } });
    }
    if (url.endsWith("/templates")) {
      return respond(routes.templates ?? { status: 200, body: { templates } });
    }
    if (url.includes("/email-invitations")) {
      return respond(invites.length > 1 ? invites.shift()! : invites[0]);
    }
    if (url.includes("/business-units/find")) {
      return respond(routes.find ?? { status: 200, body: { id: "bu_found", displayName: "Alder & Co." } });
    }
    if (url.includes("/business-units/")) {
      return respond(
        routes.unit ?? {
          status: 200,
          body: { id: "bu_1", displayName: "Alder & Co.", score: { trustScore: 4.6 }, numberOfReviews: { total: 128 } },
        },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

// [method, url, headers, parsed body] of a fetch call
export function callOf(call: any[]) {
  const [url, init] = call;
  let body: any = init?.body;
  try {
    body = body ? JSON.parse(body) : undefined;
  } catch {
    // form-encoded bodies stay as strings
  }
  return { method: init?.method, url: String(url), headers: init?.headers, body };
}

// fetch calls to the invitation endpoint
export function inviteCalls(fetchMock: ReturnType<typeof mockTrustpilot>) {
  return fetchMock.mock.calls.map(callOf).filter((call) => call.url.includes("/email-invitations"));
}

// swell client mock: get returns the order, put records writes
export function makeSwell(order: any = makeOrder(), settings: any = rawSettings) {
  return {
    get: vi.fn().mockResolvedValue(order),
    put: vi.fn().mockResolvedValue({}),
    settings: vi.fn().mockResolvedValue({ trustpilot: settings }),
  };
}
