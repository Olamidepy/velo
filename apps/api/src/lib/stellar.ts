import {
    BASE_FEE,
    Keypair,
    Networks,
    Operation,
    TransactionBuilder,
    nativeToScVal,
    scValToNative,
    xdr,
} from "@stellar/stellar-sdk";
import { Server, Api, assembleTransaction } from "@stellar/stellar-sdk/rpc";

const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;

export const server = new Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

/**
 * Loads the deployer/buyer keypair used to sign escrow calls.
 *
 * TODO (production): this is a custodial shortcut for testnet — the API
 * signs on the user's behalf using a backend-held key. Before mainnet,
 * replace this with non-custodial flow: the API returns an unsigned XDR
 * transaction, the user's wallet (or an agent's signer) signs it
 * client-side, and only the signed envelope comes back to be submitted.
 */
function loadSignerKeypair(): Keypair {
    if (process.env.STELLAR_NETWORK === "PUBLIC") {
        throw new Error("Custodial signer cannot be used on mainnet.");
    }
    const secret = process.env.BUYER_SECRET_KEY;
    if (!secret) {
        throw new Error(
            "BUYER_SECRET_KEY not set — see apps/api/.env.example. This is a " +
            "testnet-only signer used until non-custodial signing is wired up."
        );
    }
    return Keypair.fromSecret(secret);
}

/** Converts a 64-char hex string into the BytesN<32> scval Soroban expects. */
function hexToBytesScVal(hex: string) {
    if (hex.length !== 64) {
        throw new Error(`expected 32-byte hex string (64 chars), got ${hex.length} chars`);
    }
    return nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" });
}

/**
 * Minimal structural logger, satisfied by Fastify's request-scoped
 * `req.log` (pino). Routes pass their request logger down so every
 * lifecycle stage logged here carries the request's `reqId` and can be
 * correlated in the log viewer — see docs/request-tracing.md.
 */
export interface StellarLogger {
    info: (obj: Record<string, unknown>, msg?: string) => void;
    error: (obj: Record<string, unknown>, msg?: string) => void;
    child: (bindings: Record<string, unknown>) => StellarLogger;
}

/** Fallback for callers without a request context (scripts, tests). */
const noopLogger: StellarLogger = {
    info: () => { },
    error: () => { },
    child: () => noopLogger,
};

/**
 * Builds, simulates, signs, submits, and polls a Soroban contract
 * invocation to completion. Throws if the transaction fails at any
 * stage. Returns the decoded native return value on success.
 *
 * Each stage (simulate → sign → submit → poll) is logged through the
 * provided request-scoped logger with a `stage` field, so a single
 * request's on-chain lifecycle can be traced end to end by its reqId.
 */
async function invokeContract(
    contractId: string,
    functionName: string,
    args: xdr.ScVal[],
    signer: Keypair,
    log: StellarLogger = noopLogger
): Promise<unknown> {
    const stageLog = log.child({ contract: contractId, fn: functionName });

    stageLog.info({ stage: "build", signer: signer.publicKey() }, "building contract invocation");
    const account = await server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(
            Operation.invokeContractFunction({
                contract: contractId,
                function: functionName,
                args,
            })
        )
        .setTimeout(30)
        .build();

    stageLog.info({ stage: "simulate" }, "simulating transaction");
    const sim = await server.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
        stageLog.error({ stage: "simulate", error: sim.error }, "simulation failed");
        throw new Error(`simulation failed: ${sim.error}`);
    }

    const prepared = assembleTransaction(tx, sim).build();
    prepared.sign(signer);
    const txHash = prepared.hash().toString("hex");
    stageLog.info({ stage: "sign", txHash }, "transaction signed");

    stageLog.info({ stage: "submit", txHash }, "submitting transaction");
    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status === "ERROR") {
        stageLog.error(
            { stage: "submit", txHash, errorResult: JSON.stringify(sendResult.errorResult) },
            "submission failed"
        );
        throw new Error(`submission failed: ${JSON.stringify(sendResult.errorResult)}`);
    }
    stageLog.info({ stage: "submit", txHash, status: sendResult.status }, "transaction accepted");

    let getResult = await server.getTransaction(sendResult.hash);
    const start = Date.now();
    let attempts = 1;
    while (getResult.status === Api.GetTransactionStatus.NOT_FOUND) {
        if (Date.now() - start > 30_000) {
            stageLog.error(
                { stage: "poll", txHash, attempts, elapsedMs: Date.now() - start },
                "timed out waiting for confirmation"
            );
            throw new Error(`timed out waiting for tx ${sendResult.hash} to confirm`);
        }
        await new Promise((r) => setTimeout(r, 1500));
        getResult = await server.getTransaction(sendResult.hash);
        attempts += 1;
    }

    if (getResult.status !== Api.GetTransactionStatus.SUCCESS) {
        stageLog.error(
            { stage: "poll", txHash, attempts, status: getResult.status },
            "transaction failed on-chain"
        );
        throw new Error(`tx ${sendResult.hash} failed with status ${getResult.status}`);
    }

    stageLog.info(
        { stage: "poll", txHash, attempts, elapsedMs: Date.now() - start },
        "transaction confirmed"
    );
    return getResult.returnValue ? scValToNative(getResult.returnValue) : undefined;
}

export interface LockParams {
    contractId: string;
    tradeId: string;
    seller: string;
    buyer: string;
    amountStroops: bigint;
    secretHashHex: string;
    timeoutLedgers: number;
}

/** Calls escrow's lock(id, seller, buyer, amount, secret_hash, timeout_ledgers). */
export async function lockEscrow(params: LockParams, log?: StellarLogger) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "lock",
        [
            hexToBytesScVal(params.tradeId),
            nativeToScVal(params.seller, { type: "address" }),
            nativeToScVal(params.buyer, { type: "address" }),
            nativeToScVal(params.amountStroops, { type: "i128" }),
            hexToBytesScVal(params.secretHashHex),
            nativeToScVal(params.timeoutLedgers, { type: "u32" }),
        ],
        signer,
        log
    );
}

export interface ReleaseParams {
    contractId: string;
    tradeId: string;
    secretHex: string;
}

/** Calls escrow's release(id, secret). Pays the seller, reveals the secret on-chain. */
export async function releaseEscrow(params: ReleaseParams, log?: StellarLogger) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "release",
        [hexToBytesScVal(params.tradeId), hexToBytesScVal(params.secretHex)],
        signer,
        log
    );
}

export interface RefundParams {
    contractId: string;
    tradeId: string;
}

/** Calls escrow's refund(id). Permissionless once the timeout has passed. */
export async function refundEscrow(params: RefundParams, log?: StellarLogger) {
    const signer = loadSignerKeypair();
    return invokeContract(
        params.contractId,
        "refund",
        [hexToBytesScVal(params.tradeId)],
        signer,
        log
    );
}