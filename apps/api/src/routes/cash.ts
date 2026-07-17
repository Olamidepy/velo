 import type { FastifyInstance } from "fastify";
import { CONTRACTS } from "@velo/shared";
import { lockEscrow, releaseEscrow } from "../lib/stellar.js";
import { randomHex32 } from "../lib/crypto.js";
import { saveCashRequest, getCashRequest, updateStatus, saveProvider, getProviders } from "../lib/store.js";

const ESCROW_CONTRACT_ID = process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;
const DEFAULT_TIMEOUT_LEDGERS = 100; // ~15-20 min at Stellar's ~5-6s ledger close time

interface CashRequestBody {
  seller: string; // G... address of the cash provider
  buyer: string; // G... address of the person requesting cash
  amount_stroops: string; // bigint as string, e.g. "10000000" = 1 XLM/USDC unit
  secret_hash: string; // 64-character hex string representing SHA256 of the secret
}

interface RegisterProviderBody {
  name: string;
  lat: number;
  lng: number;
  rate?: string;
}

// Simple Haversine distance
function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * GET  /api/v1/cash/agents        — find nearby cash providers ($0.001)
 * POST /api/v1/cash/agents        — register a cash provider ($0.000)
 * POST /api/v1/cash/request       — lock funds via the escrow contract,
 *                                    return a claim_url + QR payload ($0.01)
 * GET  /api/v1/cash/request/:id   — poll a pending cash request (free)
 * POST /api/v1/cash/request/:id/release — merchant confirms hand-off,
 *                                    releases escrow using the secret
 *                                    embedded in the scanned QR (free)
 */
export async function cashRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { lat?: string; lng?: string } }>(
    "/cash/agents",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
    const paid = await (app as any).requirePayment(req, reply, "0.001");
    if (!paid) return;

    const { lat, lng } = req.query;
    const providers = getProviders().filter(p => p.status === "available");
    
    if (lat && lng) {
        const userLat = parseFloat(lat);
        const userLng = parseFloat(lng);
        
        const withDistance = providers.map(p => ({
            ...p,
            distance_km: getDistanceFromLatLonInKm(userLat, userLng, p.lat, p.lng)
        }));
        
        withDistance.sort((a, b) => a.distance_km - b.distance_km);
        return { agents: withDistance };
    }

    // Default if no coords provided
    return { agents: providers };
  });

  app.post<{ Body: RegisterProviderBody }>("/cash/agents", async (req, reply) => {
      // Registration is free in this implementation
      const { name, lat, lng, rate } = req.body ?? ({} as RegisterProviderBody);
      if (!name || typeof lat !== "number" || typeof lng !== "number") {
          reply.code(400).send({ error: "name, lat (number), and lng (number) are required" });
          return;
      }
      
      const id = randomHex32();
      const provider = {
          id,
          name,
          lat,
          lng,
          rate: rate || "1.0",
          tier: "Standard",
          status: "available" as const,
          createdAt: new Date().toISOString()
      };
      
      saveProvider(provider);
      reply.code(201).send(provider);
  });

  app.post<{ Body: CashRequestBody }>(
    "/cash/request",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
    const paid = await (app as any).requirePayment(req, reply, "0.01");
    if (!paid) return;

    const { seller, buyer, amount_stroops, secret_hash } = req.body ?? ({} as CashRequestBody);
    if (!seller || !buyer || !amount_stroops || !secret_hash) {
      reply.code(400).send({ error: "seller, buyer, amount_stroops, and secret_hash are required" });
      return;
    }

    const tradeId = randomHex32();

    try {
      await lockEscrow({
        contractId: ESCROW_CONTRACT_ID,
        tradeId,
        seller,
        buyer,
        amountStroops: BigInt(amount_stroops),
        secretHashHex: secret_hash,
        timeoutLedgers: DEFAULT_TIMEOUT_LEDGERS,
      });
    } catch (err) {
      req.log.error(err, "lockEscrow failed");
      reply.code(502).send({
        error: "escrow lock failed",
        detail: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return;
    }
    saveCashRequest({
      id: tradeId,
      contractId: ESCROW_CONTRACT_ID,
      seller,
      buyer,
      amountStroops: amount_stroops,
      secretHex: "", // The API no longer knows the secret
      secretHashHex: secret_hash,
      status: "locked",
      createdAt: new Date().toISOString(),
    });

    const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
    reply.code(201).send({
      // The secret is held client-side and is NOT returned by the API
      claim_url: `${baseUrl}/claim/${tradeId}`,
      qr_payload: `velo://claim?request_id=${tradeId}&contract=${ESCROW_CONTRACT_ID}`,
      instructions: "Show this QR to the cash provider to receive your cash.",
    });
  });

  app.get<{ Params: { id: string } }>(
    "/cash/request/:id",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
    const record = getCashRequest(req.params.id);
    if (!record) {
      reply.code(404).send({ error: "request not found" });
      return;
    }
    const { secretHex: _omit, ...safe } = record;
    return safe;
  });

  app.post<{ Params: { id: string }; Body: { secret: string } }>(
    "/cash/request/:id/release",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const record = getCashRequest(req.params.id);
      if (!record) {
        reply.code(404).send({ error: "request not found" });
        return;
      }
      if (record.status !== "locked") {
        reply.code(409).send({ error: `request is already ${record.status}` });
        return;
      }

      const { secret } = req.body ?? {};
      if (!secret) {
        reply.code(400).send({ error: "secret is required (from the scanned QR)" });
        return;
      }

      try {
        await releaseEscrow({
          contractId: record.contractId,
          tradeId: record.id,
          secretHex: secret,
        });
      } catch (err) {
        req.log.error(err, "releaseEscrow failed");
        reply.code(502).send({ error: "escrow release failed", detail: String(err) });
        return;
      }

      updateStatus(record.id, "released");
      return { id: record.id, status: "released" };
    }
  );
}