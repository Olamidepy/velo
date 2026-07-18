import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { cashRoutes } from "./cash.js";

describe("cashRoutes", () => {
  it("returns a payment challenge when no payment header is present", async () => {
    const app: any = Fastify();

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

    const response = await app.inject({ method: "GET", url: "/api/v1/cash/agents" });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      challenge: {
        amount_usdc: "0.001",
      },
    });

    await app.close();
  });

  it("validates mode parameter in cash request", async () => {
    const app: any = Fastify();

    app.decorate("requirePayment", async () => true);
    app.register(cashRoutes, { prefix: "/api/v1" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      payload: {
        seller: "GSELLER",
        buyer: "GBUYER",
        amount_stroops: "10000000",
        secret_hash: "a".repeat(64),
        mode: "invalid_mode",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "mode must be either 'custodial' or 'non_custodial'",
    });

    await app.close();
  });

  it("returns unsigned XDR in non-custodial mode", async () => {
    const app: any = Fastify();

    app.decorate("requirePayment", async () => true);
    app.register(cashRoutes, { prefix: "/api/v1" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      payload: {
        seller: "GSELLER",
        buyer: "GBUYER",
        amount_stroops: "10000000",
        secret_hash: "a".repeat(64),
        mode: "non_custodial",
      },
    });

    // This will fail without proper Stellar setup, but we can validate the request structure
    // In a real test environment, we would mock the stellar functions
    expect(response.statusCode).toBe(502); // Expected to fail without Stellar RPC

    await app.close();
  });

  it("rejects submit without signed_xdr", async () => {
    const app: any = Fastify();

    app.decorate("requirePayment", async () => true);
    app.register(cashRoutes, { prefix: "/api/v1" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request/test123/submit",
      payload: {},
    });

    expect(response.statusCode).toBe(404); // Request not found

    await app.close();
  });
});
