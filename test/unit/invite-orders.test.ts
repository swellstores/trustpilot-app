import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PAGE_SIZE } from "../../functions/lib/batch";
import InviteOrders, { config } from "../../functions/invite-orders";
import { inviteCalls, makeOrder, mockTrustpilot, rawSettings } from "../helpers/trustpilot-fixtures";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// step.do runner that calls the callback directly and records step names
function makeStep() {
  const names: string[] = [];
  const step = {
    do: vi.fn(async (name: string, ...args: any[]) => {
      names.push(name);
      const callback = args[args.length - 1];
      return callback();
    }),
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
  };
  return { step: step as unknown as SwellWorkflowStep, names };
}

function makeReq(pages: any[][], settings: any = rawSettings, data: any = {}) {
  const get = vi.fn();
  pages.forEach((results) => get.mockResolvedValueOnce({ results }));
  get.mockResolvedValue({ results: [] });
  const put = vi.fn().mockResolvedValue({});
  const req = {
    appId: "trustpilot",
    store: { id: "s", url: "https://shop.example.com" },
    data,
    swell: { get, put, settings: vi.fn().mockResolvedValue({ trustpilot: settings }) },
  } as unknown as SwellWorkflowRequest;
  return { req, get, put };
}

const ids = (n: number, prefix = "o") =>
  Array.from({ length: n }, (_, i) => makeOrder({ id: `${prefix}${String(i).padStart(3, "0")}` }));

describe("invite-orders workflow", () => {
  it("is a workflow started by actions", () => {
    expect(config).toMatchObject({ kind: "workflow", action: true });
  });

  it("stops when the app is disabled", async () => {
    const fetchMock = mockTrustpilot();
    const { req, get } = makeReq([ids(1)], { ...rawSettings, enabled: false });
    const { step, names } = makeStep();

    expect(await new InviteOrders().run(req, step)).toEqual({ error: "disabled" });
    expect(names).toEqual(["load settings"]);
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops without credentials", async () => {
    const fetchMock = mockTrustpilot();
    const { req, get } = makeReq([ids(1)], { api_key: "k" });
    const { step } = makeStep();

    expect(await new InviteOrders().run(req, step)).toEqual({ error: "missing_settings" });
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invites past orders since the modal date and pages through them", async () => {
    const fetchMock = mockTrustpilot();
    const full = ids(PAGE_SIZE);
    const { req, get, put } = makeReq([full, ids(1, "z")], rawSettings, {
      since: "2026-09-01",
      $action: { id: "invite_past_orders", source: "settings", settings: "trustpilot", user_id: "u1" },
    });
    const { step, names } = makeStep();

    const totals = await new InviteOrders().run(req, step);

    expect(totals).toEqual({ sent: PAGE_SIZE + 1, skipped: 0, failed: 0 });
    expect(names).toEqual(["load settings", "page 1", "page 2"]);
    expect(get.mock.calls[0][1].$and).toEqual([
      { delivered: true },
      { canceled: { $ne: true } },
      { date_created: { $gte: "2026-09-01T00:00:00.000Z" } },
    ]);
    expect(get.mock.calls[1][1].$and).toContainEqual({ id: { $gt: full[PAGE_SIZE - 1].id } });
    expect(inviteCalls(fetchMock)).toHaveLength(PAGE_SIZE + 1);
    expect(put).toHaveBeenCalledTimes(PAGE_SIZE + 1);
  });

  it("invites the orders selected in the list", async () => {
    mockTrustpilot();
    const selection = { all: false, ids: ["o000"], count: 1, query: { $and: [{ id: { $in: ["o000"] } }] } };
    const { req, get } = makeReq([ids(1)], rawSettings, {
      $action: { id: "invite_selected", source: "bulk", collection: "orders", selection, user_id: "u1" },
    });
    const { step } = makeStep();

    expect(await new InviteOrders().run(req, step)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(get.mock.calls[0][1].$and).toEqual([{ id: { $in: ["o000"] } }]);
  });

  it("stops on an empty result without calling Trustpilot", async () => {
    const fetchMock = mockTrustpilot();
    const { req } = makeReq([]);
    const { step, names } = makeStep();

    expect(await new InviteOrders().run(req, step)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(names).toEqual(["load settings", "page 1"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops sending when the app is disabled during the run", async () => {
    const fetchMock = mockTrustpilot();
    const { req, get } = makeReq([ids(PAGE_SIZE), ids(1, "z")]);
    (req.swell.settings as any)
      .mockResolvedValueOnce({ trustpilot: rawSettings })
      .mockResolvedValueOnce({ trustpilot: rawSettings })
      .mockResolvedValue({ trustpilot: { ...rawSettings, enabled: false } });
    const { step, names } = makeStep();

    const totals = await new InviteOrders().run(req, step);

    expect(totals).toEqual({ sent: PAGE_SIZE, skipped: 0, failed: 0, error: "disabled" });
    expect(names).toEqual(["load settings", "page 1", "page 2"]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(inviteCalls(fetchMock)).toHaveLength(PAGE_SIZE);
  });

  it("retries pages with backoff", async () => {
    mockTrustpilot();
    const { req } = makeReq([]);
    const { step } = makeStep();

    await new InviteOrders().run(req, step);

    expect((step.do as any).mock.calls[1][1]).toEqual({
      retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
    });
  });
});
