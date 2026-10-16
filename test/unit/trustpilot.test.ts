import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TrustpilotError,
  alreadyInvited,
  appValues,
  buildInvitation,
  buildProducts,
  consumerName,
  createInviteContext,
  getAccessToken,
  getSettings,
  handleError,
  inviteOrder,
  loadSettings,
  missingSettings,
  parseTags,
  pickTemplate,
  productUrl,
  sendTime,
  skipReason,
  storeDomain,
  trustpilotRequest,
  environmentSkip,
  swellEnv,
} from "../../functions/lib/trustpilot";
import {
  callOf,
  inviteCalls,
  makeContext,
  makeOrder,
  makeSettings,
  makeSwell,
  mockTrustpilot,
  rawSettings,
  templates,
} from "../helpers/trustpilot-fixtures";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getSettings", () => {
  it("applies defaults", () => {
    expect(getSettings({ trustpilot: rawSettings })).toEqual({
      api_key: "tp-key",
      api_secret: "tp-secret",
      business_unit_id: "bu_1",
      enabled: true,
      invite_on: "delivered",
      delay_days: 3,
      locale: "en-US",
      sender_name: "",
      reply_to: "",
      service_template_id: "",
      tags: [],
      redirect_uri: "",
      product_reviews: false,
      product_template_id: "",
      product_url: "",
      invite_test_orders: false,
    });
  });

  it("keeps the default delay when Days to wait is cleared", () => {
    expect(getSettings({ trustpilot: { ...rawSettings, delay_days: null } }).delay_days).toBe(3);
    expect(getSettings({ trustpilot: { ...rawSettings, delay_days: "" } }).delay_days).toBe(3);
    expect(getSettings({ trustpilot: { ...rawSettings, delay_days: 0 } }).delay_days).toBe(0);
    expect(getSettings({ trustpilot: { ...rawSettings, delay_days: "0" } }).delay_days).toBe(0);
  });

  it("reads the environment from Swell-Env and skips test orders unless allowed", () => {
    expect(swellEnv({ headers: new Headers({ "Swell-Env": "test" }) })).toBe("test");
    expect(swellEnv({ headers: new Headers({ "Swell-Env": "Test" }) })).toBeNull();
    expect(swellEnv({ headers: new Headers() })).toBeNull();
    expect(swellEnv({})).toBeNull();
    expect(environmentSkip(makeSettings(), "test")).toBe("test environment order (Invite test orders is off)");
    expect(environmentSkip(makeSettings({ invite_test_orders: true }), "test")).toBeNull();
    expect(environmentSkip(makeSettings(), null)).toBeNull();
  });

  it("reads saved values and trims text", () => {
    const settings = getSettings({
      trustpilot: { ...rawSettings, api_key: " k ", invite_on: "paid", delay_days: "7", enabled: false, tags: "a, b,," },
    });
    expect(settings).toMatchObject({ api_key: "k", invite_on: "paid", delay_days: 7, enabled: false, tags: ["a", "b"] });
  });

  it("falls back on invalid values and caps the delay", () => {
    expect(getSettings({ trustpilot: { invite_on: "shipped", delay_days: -1 } })).toMatchObject({
      invite_on: "delivered",
      delay_days: 3,
    });
    expect(getSettings({ trustpilot: { delay_days: 400 } }).delay_days).toBe(90);
    expect(getSettings({ trustpilot: { delay_days: 0 } }).delay_days).toBe(0);
    expect(getSettings(undefined).api_key).toBe("");
  });
});

describe("parseTags", () => {
  it("splits strings and accepts arrays", () => {
    expect(parseTags(" swell , shop ")).toEqual(["swell", "shop"]);
    expect(parseTags(["x", " ", 2])).toEqual(["x", "2"]);
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("missingSettings / loadSettings", () => {
  it("lists missing credentials", () => {
    expect(missingSettings(getSettings({}))).toEqual(["API key", "API secret", "Business unit ID"]);
    expect(missingSettings(makeSettings())).toEqual([]);
  });

  it("returns settings when enabled and complete", async () => {
    expect(await loadSettings(makeSwell())).toMatchObject({ api_key: "tp-key" });
  });

  it("returns null when disabled", async () => {
    expect(await loadSettings(makeSwell(undefined, { ...rawSettings, enabled: false }))).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns null and logs when credentials are missing", async () => {
    expect(await loadSettings(makeSwell(undefined, { api_key: "k" }))).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("Trustpilot: missing API secret, Business unit ID in app settings");
  });
});

describe("trustpilotRequest", () => {
  it("parses JSON and empty bodies", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response('{"a":1}', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    expect(await trustpilotRequest("https://x", {})).toEqual({ a: 1 });
    expect(await trustpilotRequest("https://x", {})).toBeNull();
  });

  it("throws TrustpilotError with the API message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"message":"Invalid email"}', { status: 400 }));
    const err = await trustpilotRequest("https://x", {}).catch((e) => e);
    expect(err).toBeInstanceOf(TrustpilotError);
    expect(err.message).toBe("Trustpilot 400: Invalid email");
    expect(err.retryable).toBe(false);
  });

  it("marks network errors, 429 and 5xx as retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    const network = await trustpilotRequest("https://x", {}).catch((e) => e);
    expect(network.status).toBe(0);
    expect(network.retryable).toBe(true);
    expect(new TrustpilotError(429, "slow down").retryable).toBe(true);
    expect(new TrustpilotError(503, "down").retryable).toBe(true);
    expect(new TrustpilotError(401, "no").retryable).toBe(false);
  });
});

describe("getAccessToken", () => {
  it("uses the client credentials grant with Basic auth", async () => {
    const fetchMock = mockTrustpilot();
    expect(await getAccessToken(makeSettings())).toBe("token_1");
    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.url).toBe("https://api.trustpilot.com/v1/oauth/oauth-business-users-for-applications/accesstoken");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Basic ${btoa("tp-key:tp-secret")}`);
    expect(call.body).toBe("grant_type=client_credentials");
  });

  it("fails without a token in the response", async () => {
    mockTrustpilot({ token: { status: 200, body: {} } });
    await expect(getAccessToken(makeSettings())).rejects.toThrow("no access token");
  });
});

describe("pickTemplate", () => {
  it("prefers the configured template", () => {
    expect(pickTemplate(templates, "service", "tpl_set", "en-US")).toBe("tpl_set");
  });

  it("picks the default template of the kind and locale", () => {
    expect(pickTemplate(templates, "service", "", "en-US")).toBe("tpl_default_en");
    expect(pickTemplate(templates, "product", "", "en-US")).toBe("tpl_product_en");
  });

  it("falls back to any default, then a locale match, then undefined", () => {
    expect(pickTemplate(templates, "service", "", "de-DE")).toBe("tpl_default_en");
    expect(pickTemplate([templates[1]], "service", "", "en-US")).toBe("tpl_other");
    expect(pickTemplate([], "service", "", "en-US")).toBeUndefined();
  });
});

describe("createInviteContext", () => {
  it("gets a token and resolves default templates", async () => {
    const fetchMock = mockTrustpilot();
    const ctx = await createInviteContext(makeSettings({ product_reviews: true }), "https://shop.example.com/");
    expect(ctx).toMatchObject({
      token: "token_1",
      serviceTemplateId: "tpl_default_en",
      productTemplateId: "tpl_product_en",
      storeUrl: "https://shop.example.com",
    });
    expect(callOf(fetchMock.mock.calls[1]).url).toBe(
      "https://invitations-api.trustpilot.com/v1/private/business-units/bu_1/templates",
    );
  });

  it("skips the template lookup when templates are configured", async () => {
    const fetchMock = mockTrustpilot();
    const ctx = await createInviteContext(makeSettings({ service_template_id: "tpl_mine" }));
    expect(ctx.serviceTemplateId).toBe("tpl_mine");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("consumerName", () => {
  it("uses billing, account, shipping, then the email", () => {
    expect(consumerName(makeOrder())).toBe("Jane Doe");
    expect(consumerName(makeOrder({ billing: { first_name: "Ann", last_name: "Lee" } }))).toBe("Ann Lee");
    expect(consumerName(makeOrder({ billing: {} }))).toBe("Jane Doe");
    expect(consumerName({ account: { email: "sam@example.com" } })).toBe("sam");
  });
});

describe("productUrl", () => {
  it("fills the template or uses the store URL", () => {
    const product = { id: "p1", slug: "shirt" };
    expect(productUrl(product, "https://x.com/p/{slug}?id={id}", "")).toBe("https://x.com/p/shirt?id=p1");
    expect(productUrl(product, "", "https://shop.example.com")).toBe("https://shop.example.com/products/shirt");
    expect(productUrl(product, "", "")).toBeUndefined();
    expect(productUrl(null, "", "https://shop.example.com")).toBeUndefined();
  });

  it("leaves the URL out when the product can't fill a placeholder", () => {
    expect(productUrl({ id: "p1" }, "https://x.com/p/{slug}", "")).toBeUndefined();
    expect(productUrl({ slug: "shirt" }, "https://x.com/p/{id}", "")).toBeUndefined();
    expect(productUrl({ id: "p1" }, "https://x.com/p/{id}", "")).toBe("https://x.com/p/p1");
  });
});

describe("buildProducts", () => {
  it("maps items with SKU and name, one per SKU", () => {
    const order = makeOrder();
    order.items.push({ ...order.items[0], id: "item_2" }, { id: "item_3", product: { name: "No SKU" } } as any);
    expect(buildProducts(order, makeContext())).toEqual([
      {
        sku: "SKU-V",
        name: "Trail Shirt",
        brand: "Alder",
        imageUrl: "https://cdn/v.jpg",
        productUrl: "https://shop.example.com/products/trail-shirt",
      },
    ]);
  });
});

describe("sendTime", () => {
  it("adds the delay or sends right away", () => {
    const now = new Date("2026-10-01T10:00:00.000Z");
    expect(sendTime(3, now)).toBe("2026-10-04T10:00:00.000Z");
    expect(sendTime(0, now)).toBeUndefined();
  });
});

describe("buildInvitation", () => {
  const now = new Date("2026-10-01T10:00:00.000Z");

  it("builds a service review invitation", () => {
    const ctx = makeContext({
      settings: makeSettings({ sender_name: "Alder", reply_to: "help@alder.co", tags: ["swell"], redirect_uri: "https://alder.co/thanks" }),
    });
    expect(buildInvitation(makeOrder(), ctx, 3, now)).toEqual({
      consumerEmail: "jane@example.com",
      consumerName: "Jane Doe",
      referenceNumber: "100001",
      locale: "en-US",
      senderName: "Alder",
      replyTo: "help@alder.co",
      type: "email",
      serviceReviewInvitation: {
        templateId: "tpl_service",
        preferredSendTime: "2026-10-04T10:00:00.000Z",
        redirectUri: "https://alder.co/thanks",
        tags: ["swell"],
      },
    });
  });

  it("leaves out empty options and the send time without a delay", () => {
    const payload = buildInvitation(makeOrder(), makeContext({ serviceTemplateId: undefined }), 0, now);
    expect(payload).not.toHaveProperty("senderName");
    expect(payload).not.toHaveProperty("replyTo");
    expect(payload.serviceReviewInvitation).toEqual({});
    expect(payload).not.toHaveProperty("productReviewInvitation");
  });

  it("adds products when product reviews are on", () => {
    const ctx = makeContext({ settings: makeSettings({ product_reviews: true }) });
    const payload = buildInvitation(makeOrder(), ctx, 3, now);
    expect(payload.productReviewInvitation).toMatchObject({
      templateId: "tpl_product",
      // a minute after the service invitation, which Trustpilot requires to come first
      preferredSendTime: "2026-10-04T10:01:00.000Z",
      products: [{ sku: "SKU-V", name: "Trail Shirt" }],
    });
  });

  it("leaves out product reviews when no item has a SKU", () => {
    const ctx = makeContext({ settings: makeSettings({ product_reviews: true }) });
    const payload = buildInvitation(makeOrder({ items: [{ product: { name: "x" } }] }), ctx, 0, now);
    expect(payload).not.toHaveProperty("productReviewInvitation");
  });
});

describe("skipReason / alreadyInvited / appValues", () => {
  it("explains why an order can't be invited", () => {
    expect(skipReason(null)).toBe("order not found");
    expect(skipReason(makeOrder({ canceled: true }))).toBe("order is canceled");
    expect(skipReason(makeOrder({ draft: true }))).toBe("order is a draft");
    expect(skipReason(makeOrder({ account: {} }))).toBe("order has no customer email");
    expect(skipReason(makeOrder())).toBeNull();
  });

  it("reads the invitation status from app values", () => {
    expect(alreadyInvited(makeOrder({ $app: { trustpilot: { trustpilot_status: "sent" } } }))).toBe(true);
    expect(alreadyInvited(makeOrder({ $app: { trustpilot: { trustpilot_status: "failed" } } }))).toBe(false);
    expect(alreadyInvited(makeOrder())).toBe(false);
  });

  it("namespaces values under the app id", () => {
    expect(appValues({ a: 1 })).toEqual({ $app: { trustpilot: { a: 1 } } });
    expect(appValues({ a: 1 }, "other")).toEqual({ $app: { other: { a: 1 } } });
  });
});

describe("inviteOrder", () => {
  it("sends the invitation and records it on the order", async () => {
    const fetchMock = mockTrustpilot();
    const swell = makeSwell();
    const order = makeOrder();

    expect(await inviteOrder(swell, order, makeContext(), { delayDays: 3 })).toEqual({ status: "sent" });

    const [call] = inviteCalls(fetchMock);
    expect(call.url).toBe("https://invitations-api.trustpilot.com/v1/private/business-units/bu_1/email-invitations");
    expect(call.headers.authorization).toBe("Bearer token_1");
    expect(call.body.consumerEmail).toBe("jane@example.com");

    const [path, body] = swell.put.mock.calls[0];
    expect(path).toBe(`/orders/${order.id}`);
    expect(body.$app.trustpilot).toMatchObject({ trustpilot_status: "sent", trustpilot_error: null });
    expect(body.$app.trustpilot.trustpilot_send_time).toBe(call.body.serviceReviewInvitation.preferredSendTime);
  });

  it("records the send time as now without a delay", async () => {
    mockTrustpilot();
    const swell = makeSwell();
    await inviteOrder(swell, makeOrder(), makeContext(), { delayDays: 0 });
    const values = swell.put.mock.calls[0][1].$app.trustpilot;
    expect(values.trustpilot_send_time).toBe(values.trustpilot_sent_at);
  });

  it("skips orders that can't or needn't be invited", async () => {
    const fetchMock = mockTrustpilot();
    const swell = makeSwell();
    const invited = makeOrder({ $app: { trustpilot: { trustpilot_status: "sent" } } });

    expect(await inviteOrder(swell, makeOrder({ canceled: true }), makeContext(), { delayDays: 0 })).toEqual({
      status: "skipped",
      reason: "order is canceled",
    });
    expect(await inviteOrder(swell, invited, makeContext(), { delayDays: 0 })).toEqual({
      status: "skipped",
      reason: "already invited",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(swell.put).not.toHaveBeenCalled();
  });

  it("sends again with force", async () => {
    mockTrustpilot();
    const invited = makeOrder({ $app: { trustpilot: { trustpilot_status: "sent" } } });
    expect(await inviteOrder(makeSwell(), invited, makeContext(), { delayDays: 0, force: true })).toEqual({
      status: "sent",
    });
  });

  it("records rejected invitations as failed", async () => {
    mockTrustpilot({ invite: { status: 400, body: { message: "Invalid consumer email" } } });
    const swell = makeSwell();

    const result = await inviteOrder(swell, makeOrder(), makeContext(), { delayDays: 0 });

    expect(result).toEqual({ status: "failed", reason: "Trustpilot 400: Invalid consumer email" });
    expect(swell.put.mock.calls[0][1].$app.trustpilot).toEqual({
      trustpilot_status: "failed",
      trustpilot_error: "Trustpilot 400: Invalid consumer email",
    });
  });

  it("rethrows a rate limit without recording it, since nothing was created", async () => {
    mockTrustpilot({ invite: { status: 429, body: { message: "slow down" } } });
    const swell = makeSwell();
    await expect(inviteOrder(swell, makeOrder(), makeContext(), { delayDays: 0 })).rejects.toThrow("Trustpilot 429");
    expect(swell.put).not.toHaveBeenCalled();
  });

  it.each([
    ["a server error", { status: 503, body: { message: "down" } }, "Trustpilot 503: down"],
    ["a timeout", new Error("The operation timed out"), "Trustpilot 0: The operation timed out"],
  ])("records %s as unconfirmed and doesn't retry", async (_, reply, reason) => {
    mockTrustpilot({ invite: reply as any });
    const swell = makeSwell();

    expect(await inviteOrder(swell, makeOrder(), makeContext(), { delayDays: 0 })).toEqual({
      status: "unconfirmed",
      reason,
    });
    const values = swell.put.mock.calls[0][1].$app.trustpilot;
    expect(values.trustpilot_status).toBe("unconfirmed");
    expect(values.trustpilot_error).toBe(
      `${reason}. Trustpilot may have created the invitation: check your invitations in Trustpilot Business before sending again.`,
    );
  });

  it("doesn't invite an unconfirmed order again unless forced", async () => {
    const fetchMock = mockTrustpilot();
    const order = makeOrder({ $app: { trustpilot: { trustpilot_status: "unconfirmed" } } });

    expect(await inviteOrder(makeSwell(), order, makeContext(), { delayDays: 0 })).toEqual({
      status: "skipped",
      reason: "already invited",
    });
    expect(inviteCalls(fetchMock)).toHaveLength(0);
    expect(await inviteOrder(makeSwell(), order, makeContext(), { delayDays: 0, force: true })).toEqual({ status: "sent" });
  });

  it("doesn't throw when the order can't be updated after sending", async () => {
    const fetchMock = mockTrustpilot();
    const swell = makeSwell();
    swell.put.mockRejectedValue(new Error("Swell unavailable"));

    expect(await inviteOrder(swell, makeOrder(), makeContext(), { delayDays: 0 })).toEqual({ status: "sent" });
    expect(inviteCalls(fetchMock)).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Trustpilot: invitation result for order .+ not saved \(sent\):$/),
      "Swell unavailable",
    );
  });

  it("writes under another app id when given", async () => {
    mockTrustpilot();
    const swell = makeSwell();
    await inviteOrder(swell, makeOrder(), makeContext(), { delayDays: 0, appId: "trustpilot_dev" });
    expect(Object.keys(swell.put.mock.calls[0][1].$app)).toEqual(["trustpilot_dev"]);
  });
});

describe("storeDomain", () => {
  it("returns the host without www", () => {
    expect(storeDomain("https://www.alder.co/shop")).toBe("alder.co");
    expect(storeDomain("not a url")).toBe("");
    expect(storeDomain(undefined)).toBe("");
  });
});

describe("handleError", () => {
  it("rethrows retryable errors and logs the rest", () => {
    expect(() => handleError("x", new TrustpilotError(429, "slow"))).toThrow(TrustpilotError);
    handleError("x", new TrustpilotError(400, "bad"));
    expect(errorSpy).toHaveBeenCalledWith("Trustpilot: x failed: Trustpilot 400: bad");
    handleError("x", new TrustpilotError(400, "bad", "POST /v1/x"));
    expect(errorSpy).toHaveBeenCalledWith("Trustpilot: x failed: Trustpilot 400: bad (POST /v1/x)");
    handleError("x", new Error("plain"));
    expect(errorSpy).toHaveBeenCalledWith("Trustpilot: x failed: plain");
  });
});
