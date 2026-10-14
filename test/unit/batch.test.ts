import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PAGE_SIZE,
  addStats,
  emptyStats,
  fetchOrders,
  invitePage,
  parseSince,
  pastOrdersQuery,
  stateFilter,
} from "../../functions/lib/batch";
import { inviteCalls, makeContext, makeOrder, makeSwell, mockTrustpilot } from "../helpers/trustpilot-fixtures";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emptyStats / addStats", () => {
  it("starts at zero and sums pages", () => {
    expect(emptyStats()).toEqual({ sent: 0, skipped: 0, failed: 0, unconfirmed: 0 });
    expect(
      addStats({ sent: 1, skipped: 2, failed: 3, unconfirmed: 1 }, { sent: 4, skipped: 5, failed: 6, unconfirmed: 2 }),
    ).toEqual({
      sent: 5,
      skipped: 7,
      failed: 9,
      unconfirmed: 3,
    });
  });
});

describe("stateFilter / pastOrdersQuery", () => {
  it("matches the Send invitation when setting", () => {
    expect(stateFilter("delivered")).toEqual({ delivered: true });
    expect(stateFilter("paid")).toEqual({ paid: true });
    expect(stateFilter("submitted")).toEqual({ draft: { $ne: true } });
  });

  it("selects orders since a date that aren't canceled", () => {
    expect(pastOrdersQuery("paid", "2026-09-01T00:00:00.000Z")).toEqual({
      $and: [{ paid: true }, { canceled: { $ne: true } }, { date_created: { $gte: "2026-09-01T00:00:00.000Z" } }],
    });
  });
});

describe("parseSince", () => {
  const now = new Date("2026-10-31T00:00:00.000Z");

  it("accepts dates from the modal", () => {
    expect(parseSince("2026-09-15", 30, now)).toBe("2026-09-15T00:00:00.000Z");
    expect(parseSince("2026-09-15T10:00:00.000Z", 30, now)).toBe("2026-09-15T10:00:00.000Z");
  });

  it("falls back to 30 days ago", () => {
    expect(parseSince(undefined, 30, now)).toBe("2026-10-01T00:00:00.000Z");
    expect(parseSince("yesterday", 30, now)).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("fetchOrders", () => {
  it("pages by id with expansions", async () => {
    const get = vi.fn().mockResolvedValue({ results: [makeOrder()] });
    const query = { $and: [{ delivered: true }] };

    expect(await fetchOrders({ get }, query, null)).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/orders", {
      $and: [{ delivered: true }],
      sort: "id asc",
      limit: PAGE_SIZE,
      expand: ["account", "items.product", "items.variant"],
    });

    await fetchOrders({ get }, query, "abc");
    expect(get.mock.calls[1][1].$and).toEqual([{ delivered: true }, { id: { $gt: "abc" } }]);
    // the caller's query is not changed
    expect(query.$and).toHaveLength(1);
  });

  it("keeps other query keys and handles empty pages", async () => {
    const get = vi.fn().mockResolvedValue(null);
    expect(await fetchOrders({ get }, { search: "jane" }, null, 10)).toEqual([]);
    expect(get.mock.calls[0][1]).toMatchObject({ search: "jane", limit: 10 });
    expect(get.mock.calls[0][1]).not.toHaveProperty("$and");
  });
});

describe("invitePage", () => {
  it("counts sent, skipped, failed and unconfirmed orders without delay", async () => {
    const fetchMock = mockTrustpilot({
      invite: [{ status: 202, body: {} }, { status: 400, body: { message: "bad" } }, { status: 502, body: {} }],
    });
    const orders = [
      makeOrder({ id: "a" }),
      makeOrder({ id: "b" }),
      makeOrder({ id: "d" }),
      makeOrder({ id: "c", canceled: true }),
    ];

    const stats = await invitePage(makeSwell(), orders, makeContext());

    expect(stats).toEqual({ sent: 1, skipped: 1, failed: 1, unconfirmed: 1 });
    expect(inviteCalls(fetchMock)[0].body.serviceReviewInvitation).not.toHaveProperty("preferredSendTime");
  });

  it("rethrows a rate limit so the workflow retries the page", async () => {
    mockTrustpilot({ invite: { status: 429, body: { message: "slow down" } } });
    await expect(invitePage(makeSwell(), [makeOrder()], makeContext())).rejects.toThrow("Trustpilot 429");
  });
});
