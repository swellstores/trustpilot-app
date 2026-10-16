import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import { inviteCalls, makeOrder, makeSwell, mockTrustpilot, rawSettings } from "../helpers/trustpilot-fixtures";
import orderInvitations, { config as orderConfig } from "../../functions/order-invitations";
import testConnection, { config as testConfig } from "../../functions/test-connection";
import sendInvitation, { config as sendConfig } from "../../functions/send-invitation";
import startInvitations, { config as startConfig } from "../../functions/start-invitations";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(
  data: Record<string, any>,
  order: any = makeOrder(),
  settings: any = rawSettings,
  storeUrl = "",
  headers?: Record<string, string>,
) {
  const swell = makeSwell(order, settings);
  const req = createMockRequest({ data, swell: swell as any, store: { url: storeUrl } as any, appId: "trustpilot", headers });
  return { req, swell };
}

describe("order-invitations", () => {
  it("subscribes to the order events it can invite on", () => {
    expect(orderConfig.model?.events).toEqual(["order.submitted", "order.paid", "order.delivered"]);
  });

  it("invites on the configured event with the delay", async () => {
    const fetchMock = mockTrustpilot();
    const { req, swell } = request({ id: "ord_1", $event: { type: "order.delivered" } });

    await orderInvitations(req);

    expect(swell.get).toHaveBeenCalledWith("/orders/{id}", {
      id: "ord_1",
      expand: ["account", "items.product", "items.variant"],
    });
    const [call] = inviteCalls(fetchMock);
    expect(call.body.serviceReviewInvitation.preferredSendTime).toBeDefined();
    expect(swell.put.mock.calls[0][1].$app.trustpilot.trustpilot_status).toBe("sent");
  });

  it("ignores events other than the configured one", async () => {
    const fetchMock = mockTrustpilot();
    const { req, swell } = request({ id: "ord_1", $event: { type: "order.paid" } });

    await orderInvitations(req);

    expect(swell.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows Send invitation when", async () => {
    const fetchMock = mockTrustpilot();
    const { req } = request({ id: "ord_1", $event: { type: "order.paid" } }, makeOrder(), {
      ...rawSettings,
      invite_on: "paid",
    });

    await orderInvitations(req);

    expect(inviteCalls(fetchMock)).toHaveLength(1);
  });

  it("does nothing when the app is disabled", async () => {
    const fetchMock = mockTrustpilot();
    const { req, swell } = request({ id: "ord_1", $event: { type: "order.delivered" } }, makeOrder(), {
      ...rawSettings,
      enabled: false,
    });

    await orderInvitations(req);

    expect(swell.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing without credentials", async () => {
    const fetchMock = mockTrustpilot();
    const { req, swell } = request({ id: "ord_1", $event: { type: "order.delivered" } }, makeOrder(), {});

    await orderInvitations(req);

    expect(swell.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("logs missing credentials once per order, for the configured event only", async () => {
    mockTrustpilot();
    for (const type of ["order.submitted", "order.paid", "order.delivered"]) {
      await orderInvitations(request({ id: "ord_1", $event: { type } }, makeOrder(), { api_key: "k" }).req);
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Trustpilot: missing API secret, Business unit ID in app settings");
  });

  it("skips orders in the test environment unless Invite test orders is on", async () => {
    let fetchMock = mockTrustpilot();
    const test = { "Swell-Env": "test" };
    let { req, swell } = request({ id: "ord_1", $event: { type: "order.delivered" } }, makeOrder(), rawSettings, "", test);
    await orderInvitations(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(swell.put).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    fetchMock = mockTrustpilot();
    ({ req } = request({ id: "ord_1", $event: { type: "order.delivered" } }, makeOrder(), { ...rawSettings, invite_test_orders: true }, "", test));
    await orderInvitations(req);
    expect(inviteCalls(fetchMock)).toHaveLength(1);
  });

  it("logs when the order is not found", async () => {
    const fetchMock = mockTrustpilot();
    const { req } = request({ id: "missing", $event: { type: "order.delivered" } }, null);

    await orderInvitations(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Trustpilot: order missing not found");
  });

  it("does not invite twice", async () => {
    const fetchMock = mockTrustpilot();
    const order = makeOrder({ $app: { trustpilot: { trustpilot_status: "sent" } } });
    const { req, swell } = request({ id: "ord_1", $event: { type: "order.delivered" } }, order);

    await orderInvitations(req);

    expect(inviteCalls(fetchMock)).toHaveLength(0);
    expect(swell.put).not.toHaveBeenCalled();
  });

  it("doesn't get a token for orders that won't be invited", async () => {
    for (const order of [
      makeOrder({ $app: { trustpilot: { trustpilot_status: "unconfirmed" } } }),
      makeOrder({ canceled: true }),
      makeOrder({ account: { email: "" } }),
    ]) {
      const fetchMock = mockTrustpilot();
      await orderInvitations(request({ id: "ord_1", $event: { type: "order.delivered" } }, order).req);
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock.mockRestore();
    }
  });

  it("logs rejected credentials without retrying", async () => {
    mockTrustpilot({ token: { status: 401, body: { message: "Unauthorized" } } });
    const { req } = request({ id: "ord_1", $event: { type: "order.delivered" } });

    await expect(orderInvitations(req)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "Trustpilot: invitation for order ord_1 failed: Trustpilot 401: Unauthorized (POST /v1/oauth/oauth-business-users-for-applications/accesstoken)",
    );
  });

  it("throws a rate limit so Swell retries", async () => {
    mockTrustpilot({ invite: { status: 429, body: { message: "slow down" } } });
    const { req } = request({ id: "ord_1", $event: { type: "order.delivered" } });

    await expect(orderInvitations(req)).rejects.toThrow("Trustpilot 429");
  });

  it("throws a token outage so Swell retries, before anything is sent", async () => {
    const fetchMock = mockTrustpilot({ token: { status: 503, body: { message: "down" } } });
    const { req } = request({ id: "ord_1", $event: { type: "order.delivered" } });

    await expect(orderInvitations(req)).rejects.toThrow("Trustpilot 503");
    expect(inviteCalls(fetchMock)).toHaveLength(0);
  });

  it("doesn't retry an invitation Trustpilot didn't confirm", async () => {
    mockTrustpilot({ invite: { status: 503, body: { message: "down" } } });
    const { req, swell } = request({ id: "ord_1", $event: { type: "order.delivered" } });

    await expect(orderInvitations(req)).resolves.toBeUndefined();
    expect(swell.put.mock.calls[0][1].$app.trustpilot.trustpilot_status).toBe("unconfirmed");
  });
});

// failures are thrown as a 400 so the admin shows them as a red error popup
async function expectFailure(result: Promise<unknown>, message: string) {
  await expect(result).rejects.toMatchObject({ name: "SwellError", status: 400, message });
}

describe("start-invitations", () => {
  const start = async (data: any, headers?: Record<string, string>) => {
    const { req, swell } = request(data, makeOrder(), rawSettings, "https://shop.example.com", headers);
    const create = vi.fn().mockResolvedValue({ id: "wf_1", status: "active" });
    (swell as any).workflows = { create };
    const result = await startInvitations(req);
    return { result, create };
  };

  it("starts past-order invitations with the date, environment and store URL", async () => {
    expect(startConfig).toMatchObject({ action: true });
    const { result, create } = await start(
      { since: "2026-09-01", $action: { id: "invite_past_orders", source: "settings" } },
      { "Swell-Env": "test" },
    );
    expect(result).toEqual({ message: "Invitations started. Follow them in the Workflows tab of the Trustpilot app." });
    expect(create).toHaveBeenCalledWith("invite-orders", { env: "test", store_url: "https://shop.example.com", since: "2026-09-01" });
  });

  it("passes the orders selected in the list", async () => {
    const query = { $and: [{ id: { $in: ["o000"] } }] };
    const { create } = await start({ $action: { id: "invite_selected", source: "bulk", selection: { query } } });
    expect(create).toHaveBeenCalledWith("invite-orders", { env: null, store_url: "https://shop.example.com", query });
  });
});

describe("test-connection", () => {
  it("is a settings action", () => {
    expect(testConfig).toMatchObject({ action: true });
  });

  it("asks for credentials when missing", async () => {
    const fetchMock = mockTrustpilot();
    const { req } = request({}, null, {});
    await expectFailure(testConnection(req), "Add your Trustpilot API key and secret and save the settings first.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the business unit, TrustScore and templates", async () => {
    mockTrustpilot();
    const { req } = request({}, null);
    const { message } = await testConnection(req);
    expect(message).toBe(
      "Connected to Alder & Co. TrustScore 4.6 from 128 reviews. " +
        "Templates: Default (en-US, default) = tpl_default_en; Other (en-US) = tpl_other; Products (en-US, default) = tpl_product_en.",
    );
  });

  it("looks up the business unit by the store domain", async () => {
    const fetchMock = mockTrustpilot();
    const { req } = request({}, null, { api_key: "k", api_secret: "s" }, "https://www.alder.co");
    const { message } = await testConnection(req);
    expect(message).toBe(
      "Found Alder & Co. for alder.co. Business unit ID: bu_found. Enter it in the settings and save.",
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.trustpilot.com/v1/business-units/find?name=alder.co");
  });

  it("explains when no business unit matches the domain", async () => {
    mockTrustpilot({ find: { status: 404, body: { message: "Not found" } } });
    const { req } = request({}, null, { api_key: "k", api_secret: "s" }, "https://alder.co");
    await expectFailure(
      testConnection(req),
      "No Trustpilot business unit found for alder.co. Enter your Business unit ID, then save the settings.",
    );
  });

  it("asks for the business unit ID without a store URL", async () => {
    mockTrustpilot();
    const { req } = request({}, null, { api_key: "k", api_secret: "s" });
    await expectFailure(testConnection(req), "Enter your Business unit ID, then save the settings.");
  });

  it("explains rejected credentials", async () => {
    mockTrustpilot({ token: { status: 401, body: { message: "Unauthorized" } } });
    const { req } = request({}, null);
    await expectFailure(
      testConnection(req),
      "Trustpilot rejected the API key or secret. Check them in Trustpilot Business → Integrations → Developers → APIs, " +
        "and that your Trustpilot plan includes the API module (not available on the free plan).",
    );
  });

  it("explains an unknown business unit", async () => {
    mockTrustpilot({ unit: { status: 404, body: { message: "Not found" } } });
    const { req } = request({}, null);
    await expectFailure(testConnection(req), "Business unit bu_1 was not found in Trustpilot. Check the ID.");
  });

  it("reports other failures, with try again only for temporary ones", async () => {
    mockTrustpilot({ unit: { status: 500, body: { message: "boom" } } });
    await expectFailure(
      testConnection(request({}, null).req),
      "Trustpilot request failed, try again later: Trustpilot 500: boom",
    );

    vi.restoreAllMocks();
    mockTrustpilot({ templates: { status: 400, body: { message: "bad request" } } });
    await expectFailure(
      testConnection(request({}, null).req),
      "Trustpilot request failed: Trustpilot 400: bad request",
    );
  });

  it("doesn't report a 404 from the templates as an unknown business unit", async () => {
    mockTrustpilot({ templates: { status: 404, body: { message: "Not found" } } });
    await expectFailure(testConnection(request({}, null).req), "Trustpilot request failed: Trustpilot 404: Not found");
  });

  it("works while the app is disabled, and says it's off", async () => {
    mockTrustpilot();
    const { req } = request({}, null, { ...rawSettings, enabled: false });
    const { message } = await testConnection(req);
    expect(message).toMatch(/^Connected to Alder & Co\./);
    expect(message).toMatch(/The app is turned off, so no invitations are sent until you turn it on\.$/);
  });
});

describe("send-invitation", () => {
  const ORDER_ID = "64b7f0c2a1b2c3d4e5f60718";
  const action = (extra: Record<string, any> = {}) => ({
    $action: { id: "send_invitation", source: "record", collection: "orders", record_id: ORDER_ID, user_id: "u1" },
    ...extra,
  });

  it("is an order action", () => {
    expect(sendConfig).toMatchObject({ action: true });
  });

  it("sends right away and confirms", async () => {
    const fetchMock = mockTrustpilot();
    const { req, swell } = request(action());

    expect(await sendInvitation(req)).toEqual({ message: "Invitation sent to jane@example.com." });
    expect(swell.get.mock.calls[0][1].id).toBe(ORDER_ID);
    expect(inviteCalls(fetchMock)[0].body.serviceReviewInvitation).not.toHaveProperty("preferredSendTime");
  });

  it("refuses when the app is disabled or not set up", async () => {
    const fetchMock = mockTrustpilot();
    await expectFailure(
      sendInvitation(request(action(), makeOrder(), { ...rawSettings, enabled: false }).req),
      "The Trustpilot app is turned off in its settings.",
    );
    await expectFailure(
      sendInvitation(request(action(), makeOrder(), { api_key: "k" }).req),
      "Add the API secret, Business unit ID in Apps → Trustpilot first.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid record id", async () => {
    const { req } = request({ $action: { id: "send_invitation", record_id: "../x" } });
    await expect(sendInvitation(req)).rejects.toThrow("Open an order to run this action");
  });

  it("explains an order that was already invited", async () => {
    const fetchMock = mockTrustpilot();
    const order = makeOrder({
      $app: { trustpilot: { trustpilot_status: "sent", trustpilot_sent_at: "2026-10-02T09:00:00.000Z" } },
    });
    await expectFailure(
      sendInvitation(request(action(), order).req),
      'This order was already invited on 2026-10-02. Tick "Send again" to send another invitation.',
    );
    expect(inviteCalls(fetchMock)).toHaveLength(0);
  });

  it("sends again when asked", async () => {
    const fetchMock = mockTrustpilot();
    const order = makeOrder({ $app: { trustpilot: { trustpilot_status: "sent" } } });
    expect(await sendInvitation(request(action({ send_again: true }), order).req)).toEqual({
      message: "Invitation sent to jane@example.com.",
    });
    expect(inviteCalls(fetchMock)).toHaveLength(1);
  });

  it("explains skipped and rejected orders", async () => {
    mockTrustpilot({ invite: { status: 400, body: { message: "Invalid email" } } });
    await expectFailure(
      sendInvitation(request(action(), makeOrder({ canceled: true })).req),
      "Not sent: order is canceled.",
    );
    await expectFailure(
      sendInvitation(request(action()).req),
      "Trustpilot did not accept the invitation: Trustpilot 400: Invalid email",
    );
  });

  it("refuses test environment orders unless Invite test orders is on", async () => {
    const fetchMock = mockTrustpilot();
    await expectFailure(
      sendInvitation(request(action(), makeOrder(), rawSettings, "", { "Swell-Env": "test" }).req),
      "Not sent: test environment order (Invite test orders is off).",
    );
    expect(inviteCalls(fetchMock)).toHaveLength(0);
  });

  it("explains rejected credentials and outages", async () => {
    mockTrustpilot({ token: { status: 401, body: { message: "Unauthorized" } } });
    await expectFailure(
      sendInvitation(request(action()).req),
      "Trustpilot rejected the API key or secret, or your plan doesn't include the API module. " +
        "Run Test connection in Apps → Trustpilot.",
    );

    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockTrustpilot({ token: { status: 503, body: { message: "down" } } });
    await expectFailure(
      sendInvitation(request(action()).req),
      "Trustpilot request failed, try again later: Trustpilot 503: down",
    );

    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockTrustpilot({ token: { status: 400, body: { message: "invalid_request" } } });
    await expectFailure(
      sendInvitation(request(action()).req),
      "Trustpilot request failed: Trustpilot 400: invalid_request",
    );
  });

  it("explains an invitation Trustpilot didn't confirm", async () => {
    mockTrustpilot({ invite: { status: 503, body: { message: "down" } } });
    await expectFailure(
      sendInvitation(request(action()).req),
      "Trustpilot didn't confirm the invitation (Trustpilot 503: down). It may have been created: " +
        "check your invitations in Trustpilot Business before sending again.",
    );

    const order = makeOrder({ $app: { trustpilot: { trustpilot_status: "unconfirmed" } } });
    await expectFailure(
      sendInvitation(request(action(), order).req),
      "Trustpilot didn't confirm the last invitation for this order. Check your invitations in Trustpilot Business, " +
        'and tick "Send again" only if it isn\'t there.',
    );
  });
});
