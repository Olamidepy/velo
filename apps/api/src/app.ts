import Fastify from "fastify";
import "dotenv/config";
import { cashRoutes } from "./routes/cash.js";
import { reputationRoutes } from "./routes/reputation.js";
import { servicesRoutes } from "./routes/services.js";

export const app = Fastify({ logger: true });

/**
 * x402 gate — every paid route calls this. If no valid X-Payment header
 * is present, respond 402 with a challenge describing what to pay and
 * where. This is the entire "auth" system: payment IS authentication,
 * there are no API keys or accounts.
 *
 * TODO: replace the stub check with real Stellar tx verification
 * (submitted, correct amount, correct destination, memo matches, not
 * already used — track spent tx hashes to prevent replay).
 */
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
  // TODO: verify payment on-chain here.
  return true;
});

app.get("/health", async () => ({ ok: true }));

app.register(servicesRoutes, { prefix: "/api/v1" });
app.register(cashRoutes, { prefix: "/api/v1" });
app.register(reputationRoutes, { prefix: "/api/v1" });
