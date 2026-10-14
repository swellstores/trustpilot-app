import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import { inviteCalls, makeOrder, makeSwell, mockTrustpilot, rawSettings } from "../helpers/trustpilot-fixtures";
import orderInvitations, { config as orderConfig } from "../../functions/order-invitations";
import testConnection, { config as testConfig } from "../../functions/test-connection";
import sendInvitation, { config as sendConfig } from "../../functions/send-invitation";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(data: Record<string, any>, order: any = makeOrder(), settings: any = rawSettings, storeUrl = "") {
  const swell = makeSwell(order, settings);
  const req = createMockRequest({ data, swell: swell as any, store: { url: storeUrl } as any, appId: "trustpilot" });
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

  it("logs rejected credentials without retrying", async () => {
    mockTrustpilot({ token: { status: 401, body: { message: "Unauthorized" } } });
    const { req } = request({ id: "ord_1", $event: { type: "order.delivered" } });

    await expect(orderInvitations(req)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith("Trustpilot: invitation for order ord_1 failed:", "Trustpilot 401: Unauthorized");
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

describe("test-connection", () => {
  it("is a settings action", () => {
    expect(testConfig).toMatchObject({ action: true });
  });

  it("asks for credentials when missing", async () => {
    const fetchMock = mockTrustpilot();
    const { req } = request({}, null, {});
    expect(await testConnection(req)).toEqual({
      message: "Add your Trustpilot API key and secret and save the settings first.",
    });
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
    expect((await testConnection(req)).message).toBe(
      "No Trustpilot business unit found for alder.co. Enter your Business unit ID, then save the settings.",
    );
  });

  it("asks for the business unit ID without a store URL", async () => {
    mockTrustpilot();
    const { req } = request({}, null, { api_key: "k", api_secret: "s" });
    expect((await testConnection(req)).message).toBe("Enter your Business unit ID, then save the settings.");
  });

  it("explains rejected credentials", async () => {
    mockTrustpilot({ token: { status: 401, body: { message: "Unauthorized" } } });
    const { req } = request({}, null);
    expect((await testConnection(req)).message).toMatch(/^Trustpilot rejected the API key or secret/);
  });

  it("explains an unknown business unit", async () => {
    mockTrustpilot({ unit: { status: 404, body: { message: "Not found" } } });
    const { req } = request({}, null);
    expect((await testConnection(req)).message).toBe("Business unit bu_1 was not found in Trustpilot. Check the ID.");
  });

  it("reports other failures, with try again only for temporary ones", async () => {
    mockTrustpilot({ unit: { status: 500, body: { message: "boom" } } });
    expect((await testConnection(request({}, null).req)).message).toBe(
      "Trustpilot request failed, try again later: Trustpilot 500: boom",
    );

    vi.restoreAllMocks();
    mockTrustpilot({ templates: { status: 400, body: { message: "bad request" } } });
    expect((await testConnection(request({}, null).req)).message).toBe(
      "Trustpilot request failed: Trustpilot 400: bad request",
    );
  });

  it("doesn't report a 404 from the templates as an unknown business unit", async () => {
    mockTrustpilot({ templates: { status: 404, body: { message: "Not found" } } });
    expect((await testConnection(request({}, null).req)).message).toBe(
      "Trustpilot request failed: Trustpilot 404: Not found",
    );
  });

  it("works while the app is disabled", async () => {
    mockTrustpilot();
    const { req } = request({}, null, { ...rawSettings, enabled: false });
    expect((await testConnection(req)).message).toMatch(/^Connected to Alder & Co\./);
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
    expect(await sendInvitation(request(action(), makeOrder(), { ...rawSettings, enabled: false }).req)).toEqual({
      message: "The Trustpilot app is turned off in its settings.",
    });
    expect(await sendInvitation(request(action(), makeOrder(), { api_key: "k" }).req)).toEqual({
      message: "Add the API secret, Business unit ID in Apps → Trustpilot first.",
    });
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
    expect(await sendInvitation(request(action(), order).req)).toEqual({
      message: 'This order was already invited on 2026-10-02. Tick "Send again" to send another invitation.',
    });
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
    expect(await sendInvitation(request(action(), makeOrder({ canceled: true })).req)).toEqual({
      message: "Not sent: order is canceled.",
    });
    expect(await sendInvitation(request(action()).req)).toEqual({
      message: "Trustpilot did not accept the invitation: Trustpilot 400: Invalid email",
    });
  });

  it("explains rejected credentials and outages", async () => {
    mockTrustpilot({ token: { status: 401, body: { message: "Unauthorized" } } });
    expect((await sendInvitation(request(action()).req)).message).toMatch(/^Trustpilot rejected the API key/);

    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockTrustpilot({ token: { status: 503, body: { message: "down" } } });
    expect((await sendInvitation(request(action()).req)).message).toBe(
      "Trustpilot request failed, try again later: Trustpilot 503: down",
    );

    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockTrustpilot({ token: { status: 400, body: { message: "invalid_request" } } });
    expect((await sendInvitation(request(action()).req)).message).toBe(
      "Trustpilot request failed: Trustpilot 400: invalid_request",
    );
  });

  it("explains an invitation Trustpilot didn't confirm", async () => {
    mockTrustpilot({ invite: { status: 503, body: { message: "down" } } });
    expect((await sendInvitation(request(action()).req)).message).toBe(
      "Trustpilot didn't confirm the invitation (Trustpilot 503: down). It may have been created: " +
        "check Trustpilot Business → Invitations before sending again.",
    );

    const order = makeOrder({ $app: { trustpilot: { trustpilot_status: "unconfirmed" } } });
    expect((await sendInvitation(request(action(), order).req)).message).toBe(
      "Trustpilot didn't confirm the last invitation for this order. Check Trustpilot Business → Invitations, " +
        'and tick "Send again" only if it isn\'t there.',
    );
  });
});
