# API Guide

The API layer in Velo provides a lightweight service interface for agent-assisted and application-driven flows.

## Runtime

The API is implemented with Fastify and is intended to expose payment-aware routes for cash-related requests.

## Routes

| Method | Path                          | Price (USDC) | Description                     |
|--------|-------------------------------|--------------|---------------------------------|
| GET    | `/health`                     | Free         | Health check                    |
| GET    | `/api/v1/services`            | Free         | Service catalog                 |
| GET    | `/api/v1/cash/agents`         | 0.001        | Provider discovery              |
| POST   | `/api/v1/cash/request`        | 0.01         | Create a cash request           |
| GET    | `/api/v1/cash/request/:id`    | Free         | Poll request status             |
| POST   | `/api/v1/cash/request/:id/release` | Free    | Release escrow (hand-off)       |
| GET    | `/api/v1/reputation/:address` | 0.0005       | On-chain reputation lookup      |

## Rate Limiting

All API endpoints are rate-limited per IP address to prevent abuse. The following limits are enforced:

| Endpoint                             | Limit                 | Reason                           |
|--------------------------------------|-----------------------|----------------------------------|
| `GET /health`                        | 100 req / 1 min       | Infrastructure health check      |
| `GET /api/v1/services`               | 60 req / 1 min        | Free catalog endpoint            |
| `GET /api/v1/cash/agents`            | 30 req / 1 min        | Paid discovery; limit abuse      |
| `POST /api/v1/cash/request`          | 20 req / 1 min        | Paid escrow lock (costly)        |
| `GET /api/v1/cash/request/:id`       | 60 req / 1 min        | Free polling                     |
| `POST /api/v1/cash/request/:id/release` | 20 req / 1 min     | Free state transition            |
| `GET /api/v1/reputation/:address`    | 30 req / 1 min        | Paid reputation lookup           |

When a client exceeds the limit, the API responds with `429 Too Many Requests` and a `Retry-After` header indicating the number of seconds to wait before retrying.

## Payment Gate

The current implementation uses an x402-style challenge mechanism. When a valid payment header is not present, the API returns a challenge payload rather than allowing unrestricted access.

## Configuration

The API reads environment variables from the local environment or `.env` file. The most important values include the port, merchant address, and network configuration.
