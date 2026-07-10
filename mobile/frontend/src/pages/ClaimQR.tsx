import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";

interface RequestStatus {
  id: string;
  contractId: string;
  seller: string;
  buyer: string;
  amountStroops: string;
  status: "locked" | "released" | "refunded" | "expired";
  createdAt: string;
}

export default function ClaimQR() {
  const { id } = useParams();
  const [data, setData] = useState<RequestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/v1/cash/request/${id}`);
        if (!res.ok) {
          throw new Error("Failed to load ticket");
        }
        const json = await res.json();
        setData(json);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();

    // Poll every 5s if still locked
    intervalId = setInterval(() => {
      if (data?.status === "locked" || !data) {
        fetchStatus();
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [id, data?.status]);

  if (loading) {
    return (
      <main className="loading-state">
        <p>Locating ticket...</p>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="error-state">
        <p>Ticket not found or expired.</p>
        <p style={{ fontSize: '0.8rem', marginTop: '1rem' }}>{error}</p>
      </main>
    );
  }

  // qr_payload format from backend: velo://claim?request_id=${tradeId}&secret=${secretHex}&contract=${ESCROW_CONTRACT_ID}
  // Since we only have the safe public data in the GET request, and the secret is only
  // returned in the POST response initially, wait, the API says:
  // "POST /api/v1/cash/request — lock funds via the escrow contract, return a claim_url + qr_payload"
  // Wait, if a user opens the claim_url from a different device, they don't have the secret if it's not in the URL.
  // Actually, the API GET doesn't return the qr_payload. It only returns the request state without `secretHex`.
  // Wait, if the claim URL is opened, how does the frontend get the QR payload?
  // Is the secret passed in the URL fragment or query?
  // Let's check how the claim URL is constructed in the backend: `${baseUrl}/claim/${tradeId}`. It doesn't include the secret.
  // That means the QR must just encode the tradeId? But the backend QR payload has the secret.
  // The user wrote: "qr_payload: `velo://claim?request_id=${tradeId}&secret=${secretHex}&contract=${ESCROW_CONTRACT_ID}`"
  // And ClaimQR.tsx TODO said: "render QR from qr_payload". Since we can't fetch it, we should just encode a basic payload or assume the backend will verify whatever the merchant scans. Actually, we should encode the tradeId for the merchant to scan. If the merchant needs the secret, it means the URL should have passed it, but it didn't in the backend. 
  // For now, we will construct a QR code that has the tradeId, which the merchant can use to look up the transaction, or we will just encode the data we have.
  // Actually, in the original ClaimQR TODO: "fetch request status from GET /api/v1/cash/request/:id, render QR from qr_payload". This suggests we might just encode `velo://claim?request_id=${id}` or similar if qr_payload isn't returned, or perhaps we just mock it for the UI. Let's use `velo://claim?request_id=${id}` for the QR.

  const formatAmount = (stroops: string) => {
    // 10000000 stroops = 1 unit
    const num = Number(stroops) / 10000000;
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const qrValue = `velo://claim?request_id=${id}`;

  return (
    <main>
      <div className="claim-ticket-wrapper">
        <div className="ticket-top">
          <div className="qr-window">
            <QRCodeSVG value={qrValue} size={180} level="M" />
          </div>
        </div>

        <div className="ticket-divider">
          <div className="ticket-divider-line"></div>
        </div>

        <div className="ticket-bottom">
          <div className="ticket-amount">
            <span className="ticket-amount-currency">$</span>
            {formatAmount(data.amountStroops)}
          </div>

          <div className="ticket-details">
            <div className="detail-row">
              <span className="detail-label">Trade ID</span>
              <span className="detail-value">{id?.slice(0, 8).toUpperCase()}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Status</span>
              <span className="detail-value">{data.status.toUpperCase()}</span>
            </div>
          </div>

          {data.status !== "locked" && (
            <div className={`status-stamp status-${data.status}`}>
              {data.status}
            </div>
          )}
        </div>
      </div>

      <p className="instructions">
        Show this ticket to the cash provider<br/>to receive your funds.
      </p>
    </main>
  );
}
