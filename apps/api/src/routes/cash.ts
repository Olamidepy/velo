 import type { FastifyInstance } from "fastify";
import { CONTRACTS } from "@velo/shared";
import { lockEscrow, releaseEscrow, buildLockEscrowTransaction, submitSignedTransaction } from "../lib/stellar.js";
import { randomHex32 } from "../lib/crypto.js";
import { saveCashRequest, getCashRequest, updateStatus } from "../lib/store.js";

const ESCROW_CONTRACT_ID = process.env.ESCROW_CONTRACT_ID ?? CONTRACTS.testnet.escrow;
const DEFAULT_TIMEOUT_LEDGERS = 100; // ~15-20 min at Stellar's ~5-6s ledger close time

interface CashRequestBody {
  seller: string; // G... address of the cash provider
  buyer: string; // G... address of the person requesting cash
  amount_stroops: string; // bigint as string, e.g. "10000000" = 1 XLM/USDC unit
  secret_hash: string; // 64-character hex string representing SHA256 of the secret
  mode?: "custodial" | "non_custodial"; // Default: custodial
}

/**
 * GET  /api/v1/cash/agents        — find nearby cash providers ($0.001)
 * POST /api/v1/cash/request       — lock funds via the escrow contract,
 *                                    return a claim_url + QR payload ($0.01)
 * GET  /api/v1/cash/request/:id   — poll a pending cash request (free)
 * POST /api/v1/cash/request/:id/release — merchant confirms hand-off,
 *                                    releases escrow using the secret
 *                                    embedded in the scanned QR (free —
 *                                    this is a state-transition call, not
 *                                    a discovery/search call)
 */
export async function cashRoutes(app: FastifyInstance) {
  app.get(
    "/cash/agents",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
    const paid = await (app as any).requirePayment(req, reply, "0.001");
    if (!paid) return;

    // TODO: query a real merchant registry (on-chain reputation + off-chain
    // location index). Stub data below for local dev only.
    return {
      agents: [{ name: "Farmacia Guadalupe", distance_km: 0.3, tier: "Maestro" }],
    };
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

    const { seller, buyer, amount_stroops, secret_hash, mode = "custodial" } = req.body ?? ({} as CashRequestBody);
    if (!seller || !buyer || !amount_stroops || !secret_hash) {
      reply.code(400).send({ error: "seller, buyer, amount_stroops, and secret_hash are required" });
      return;
    }
    if (mode !== "custodial" && mode !== "non_custodial") {
      reply.code(400).send({ error: "mode must be either 'custodial' or 'non_custodial'" });
      return;
    }

    const tradeId = randomHex32();

    if (mode === "custodial") {
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
        secretHex: "",
        secretHashHex: secret_hash,
        status: "locked",
        createdAt: new Date().toISOString(),
      });

      const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
      reply.code(201).send({
        claim_url: `${baseUrl}/claim/${tradeId}`,
        qr_payload: `velo://claim?request_id=${tradeId}&contract=${ESCROW_CONTRACT_ID}`,
        instructions: "Show this QR to the cash provider to receive your cash.",
      });
    } else {
      try {
        const unsignedXdr = await buildLockEscrowTransaction({
          contractId: ESCROW_CONTRACT_ID,
          tradeId,
          seller,
          buyer,
          amountStroops: BigInt(amount_stroops),
          secretHashHex: secret_hash,
          timeoutLedgers: DEFAULT_TIMEOUT_LEDGERS,
          signerPublicKey: buyer,
        });
        saveCashRequest({
          id: tradeId,
          contractId: ESCROW_CONTRACT_ID,
          seller,
          buyer,
          amountStroops: amount_stroops,
          secretHex: "",
          secretHashHex: secret_hash,
          status: "pending_signature",
          createdAt: new Date().toISOString(),
        });

        const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
        reply.code(201).send({
          request_id: tradeId,
          unsigned_xdr: unsignedXdr,
          network_passphrase: process.env.STELLAR_NETWORK === "PUBLIC" ? "Public Global Stellar Network ; September 2015" : "Test SDF Network ; September 2015",
          submit_url: `/api/v1/cash/request/${tradeId}/submit`,
          claim_url: `${baseUrl}/claim/${tradeId}`,
          qr_payload: `velo://claim?request_id=${tradeId}&contract=${ESCROW_CONTRACT_ID}`,
          instructions: "Sign the transaction with your wallet and submit to the provided endpoint.",
        });
      } catch (err) {
        req.log.error(err, "buildLockEscrowTransaction failed");
        reply.code(502).send({
          error: "failed to build transaction",
          detail: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return;
      }
    }
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

  app.post<{ Params: { id: string }; Body: { signed_xdr: string } }>(
    "/cash/request/:id/submit",
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
      if (record.status !== "pending_signature") {
        reply.code(409).send({ error: `request is in status ${record.status}, expected pending_signature` });
        return;
      }

      const { signed_xdr } = req.body ?? {};
      if (!signed_xdr) {
        reply.code(400).send({ error: "signed_xdr is required" });
        return;
      }

      try {
        const result = await submitSignedTransaction(signed_xdr);
        updateStatus(record.id, "locked");
        
        const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";
        reply.code(200).send({
          id: record.id,
          status: "locked",
          transaction_hash: result.hash,
          claim_url: `${baseUrl}/claim/${record.id}`,
          qr_payload: `velo://claim?request_id=${record.id}&contract=${record.contractId}`,
          instructions: "Show this QR to the cash provider to receive your cash.",
        });
      } catch (err) {
        req.log.error(err, "submitSignedTransaction failed");
        reply.code(502).send({ error: "transaction submission failed", detail: String(err) });
        return;
      }
    }
  );
}