import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { cashRoutes } from "./cash.js";

vi.mock("../lib/stellar.js", () => ({
  lockEscrow: vi.fn().mockResolvedValue(undefined),
  releaseEscrow: vi.fn(),
  refundEscrow: vi.fn(),
  disputeEscrow: vi.fn().mockResolvedValue(undefined),
  resolveEscrow: vi.fn().mockResolvedValue(undefined),
}));

describe("cashRoutes", () => {
  const registerApp = (app: any) => {
    app.decorate("requirePayment", async (req: any, reply: any, priceUsdc: string) => {
      const payment = req.headers["x-payment"];
      if (!payment) {
        reply.code(402).send({
          challenge: {
            amount_usdc: priceUsdc,
            pay_to: process.env.MERCHANT_ADDRESS ?? "G...SET_ME",
            memo: "velo:request",
          },
        });
        return false;
      }
      return true;
    });

    app.register(cashRoutes, { prefix: "/api/v1" });
  };

  it("returns a payment challenge when no payment header is present", async () => {
    const app: any = Fastify();
    registerApp(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/cash/agents" });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      challenge: {
        amount_usdc: "0.001",
      },
    });

    await app.close();
  });

  it("rejects malformed cash request bodies with a 400 response", async () => {
    const app: any = Fastify();
    registerApp(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      headers: { "x-payment": "test" },
      payload: {
        seller: "not-a-stellar-address",
        buyer: "G123",
        amount_stroops: "not-a-number",
        secret_hash: "abc",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_request",
    });

    await app.close();
  });

  it("POST /cash/request persists qrPayload and GET /cash/request/:id returns it matching the POST response", async () => {
    const app: any = Fastify();
    registerApp(app);

    const secretHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const postResponse = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      headers: { "x-payment": "test" },
      payload: {
        seller: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        buyer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount_stroops: "10000000",
        secret_hash: secretHash,
      },
    });

    expect(postResponse.statusCode).toBe(201);
    const postBody = postResponse.json();
    expect(postBody).toHaveProperty("qr_payload");

    const qrPayload = postBody.qr_payload;
    const tradeId = qrPayload.match(/request_id=([^&]+)/)?.[1];
    expect(tradeId).toBeTruthy();

    expect(qrPayload).toContain(`request_id=${tradeId}`);
    expect(qrPayload).toMatch(/contract=/);
    expect(qrPayload).not.toContain(secretHash);
    expect(qrPayload).not.toMatch(/secret=/);

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/v1/cash/request/${tradeId}`,
    });

    expect(getResponse.statusCode).toBe(200);
    const getBody = getResponse.json();
    expect(getBody).toHaveProperty("qrPayload");
    expect(getBody.qrPayload).toBe(qrPayload);
    expect(getBody).not.toHaveProperty("secretHex");

    await app.close();
  });

  it("POST /cash/request/:id/dispute transitions status to disputed, and resolving it via admin route works", async () => {
    const app: any = Fastify();
    registerApp(app);
    const { adminRoutes } = await import("./admin.js");
    app.register(adminRoutes);

    const postResponse = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      headers: { "x-payment": "test" },
      payload: {
        seller: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        buyer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount_stroops: "10000000",
        secret_hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      },
    });
    expect(postResponse.statusCode).toBe(201);
    const postBody = postResponse.json();
    const tradeId = postBody.qr_payload.match(/request_id=([^&]+)/)?.[1];
    expect(tradeId).toBeTruthy();

    const disputeResponse = await app.inject({
      method: "POST",
      url: `/api/v1/cash/request/${tradeId}/dispute`,
      payload: {
        caller: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        reason: "Seller never arrived with cash",
      },
    });
    expect(disputeResponse.statusCode).toBe(200);
    const disputeBody = disputeResponse.json();
    expect(disputeBody.status).toBe("disputed");
    expect(disputeBody.disputedBy).toBe("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");

    process.env.ADMIN_API_KEY = "test-api-key";
    
    const resolveResponse = await app.inject({
      method: "POST",
      url: `/admin/trades/${tradeId}/resolve`,
      headers: {
        "x-admin-api-key": "test-api-key",
      },
      payload: {
        resolve_to_buyer: true,
        notes: "Buyer provided proof of no-show",
      },
    });
    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json().new_status).toBe("refunded");

    await app.close();
  });
});
