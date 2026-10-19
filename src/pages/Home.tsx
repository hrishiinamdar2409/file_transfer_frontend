import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

import QRDisplay from "../components/QRDisplay";
import ConnectionStatus from "../components/ConnectionStatus";
import TransferProgress from "../components/TransferProgress";
import { WebRTCManager, SignalingClient } from "../services/webrtc";

interface NetworkInfo {
  addresses: string[];
  port: number;
}

interface FileMeta {
  name: string;
  size: number;
  mimeType: string;
}

export default function Home() {
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [customPublicUrl, setCustomPublicUrl] = useState("");
  const [usePublicTunnel, setUsePublicTunnel] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [transferUrl, setTransferUrl] = useState<string | null>(null);

  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("Generate a QR code to begin.");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Idle");

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const incomingMetaRef = useRef<FileMeta | null>(null);
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const receivedRef = useRef(0);

  useEffect(() => {
    async function loadNetwork() {
      try {
        const response = await fetch("/api/network");
        if (!response.ok) throw new Error("Could not load network addresses.");
        const data: NetworkInfo = await response.json();
        setNetwork(data);
        if (data.addresses.length > 0) {
          setSelectedAddress(data.addresses[0]);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to discover the network.",
        );
      }
    }
    loadNetwork();
  }, []);

  useEffect(() => {
    return () => {
      signalingRef.current?.close();
      webrtcRef.current?.close();
    };
  }, []);

  function resetReceiveState() {
    incomingMetaRef.current = null;
    chunksRef.current = [];
    receivedRef.current = 0;
    setProgress(0);
  }

  function setupLaptopConnection(id: string) {
    signalingRef.current?.close();
    webrtcRef.current?.close();

    const signaling = new SignalingClient();
    signalingRef.current = signaling;

    const webrtc = new WebRTCManager((channel) => {
      channel.binaryType = "arraybuffer";

      channel.onopen = () => {
        setConnected(true);
        setStatus("Connected. Waiting for file...");
        setMessage("Phone connected successfully.");
      };

      channel.onclose = () => {
        setConnected(false);
        setStatus("Disconnected");
      };

      channel.onmessage = (event) => {
        if (typeof event.data === "string") {
          const msg = JSON.parse(event.data);
          if (msg.type === "file-start") {
            incomingMetaRef.current = {
              name: msg.name,
              size: msg.size,
              mimeType: msg.mimeType,
            };
            chunksRef.current = [];
            receivedRef.current = 0;
            setProgress(0);
            setStatus(`Receiving ${msg.name}...`);
          } else if (msg.type === "file-end") {
            const meta = incomingMetaRef.current;
            if (!meta) return;

            const blob = new Blob(chunksRef.current, {
              type: meta.mimeType || "application/octet-stream",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = meta.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);

            setStatus(`Saved ${meta.name}`);
            setProgress(100);
            resetReceiveState();
          }
          return;
        }

        const buf = event.data as ArrayBuffer;
        chunksRef.current.push(buf);
        receivedRef.current += buf.byteLength;

        // Throttle React state updates (major re-render savings).
        const meta = incomingMetaRef.current;
        if (meta && meta.size > 0) {
          const pct = (receivedRef.current / meta.size) * 100;
          // Only re-render if ≥0.5% changed.
          setProgress((prev) => (Math.abs(pct - prev) >= 0.5 ? pct : prev));
        }
      };
    });

    webrtcRef.current = webrtc;

    webrtc.onIceCandidate((candidate) => {
      signaling.send({
        type: "ice-candidate",
        sessionId: id,
        payload: candidate.toJSON(),
      });
    });

    signaling.connect(
      "laptop",
      id,
      async (data) => {
        if (data.type === "offer") {
          const answer = await webrtc.createAnswer(data.payload);
          signaling.send({
            type: "answer",
            sessionId: id,
            payload: answer,
          });
        } else if (data.type === "ice-candidate") {
          // WebRTCManager now buffers internally if remoteDescription not set.
          await webrtc.addIceCandidate(data.payload);
        } else if (data.type === "error") {
          setError(data.message);
        }
      },
      () => setMessage("Waiting for phone to connect..."),
    );
  }

  async function createTransferSession() {
    setLoading(true);
    setError("");
    setConnected(false);
    setQrCode(null);
    setTransferUrl(null);
    setSessionId(null);
    setMessage("Creating transfer session...");
    resetReceiveState();

    try {
      const response = await fetch("/api/session", { method: "POST" });
      if (!response.ok) throw new Error("Failed to create transfer session.");

      const data: { sessionId: string } = await response.json();
      const id = data.sessionId;

      // ---- URL construction FIX ----
      // Previously: window.location.port || "5173" — WRONG behind tunnels
      // and when the page is served from a standard port (80/443).
      // Use the actual host for the "public tunnel" mode, and the local
      // IP + current port for the LAN mode.
      let baseUrl: string;
      if (usePublicTunnel && customPublicUrl.trim()) {
        baseUrl = customPublicUrl.trim().replace(/\/+$/, "");
      } else if (selectedAddress) {
        const port = window.location.port;
        baseUrl = port
          ? `http://${selectedAddress}:${port}`
          : `http://${selectedAddress}`;
      } else {
        baseUrl = window.location.origin;
      }

      const url = `${baseUrl}/join/${id}`;

      const generatedQr = await QRCode.toDataURL(url, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: "M",
      });

      setSessionId(id);
      setTransferUrl(url);
      setQrCode(generatedQr);
      setMessage("Waiting for your phone to connect.");

      setupLaptopConnection(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setMessage("Unable to create the session.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="home-page">
      <header>
        <h1>Company File Transfer</h1>
        <p>Transfer files directly between mobile data & Wi-Fi networks.</p>
      </header>

      <section>
        <h2>1. Connection Mode</h2>
        <div>
          <label>
            <input
              type="radio"
              name="netMode"
              checked={!usePublicTunnel}
              onChange={() => setUsePublicTunnel(false)}
            />
            Same Local Wi-Fi
          </label>
          <label style={{ marginLeft: "1rem" }}>
            <input
              type="radio"
              name="netMode"
              checked={usePublicTunnel}
              onChange={() => setUsePublicTunnel(true)}
            />
            Mobile Data / Different Wi-Fi (Public / Tunnel URL)
          </label>
        </div>

        {!usePublicTunnel ? (
          <div style={{ marginTop: "0.5rem" }}>
            <label htmlFor="network-address">Local IP Address: </label>
            <select
              id="network-address"
              value={selectedAddress}
              onChange={(e) => setSelectedAddress(e.target.value)}
              disabled={loading}
            >
              {network?.addresses.map((address) => (
                <option key={address} value={address}>
                  {address}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div style={{ marginTop: "0.5rem" }}>
            <label htmlFor="tunnel-url">Public/Tunnel Domain: </label>
            <input
              id="tunnel-url"
              type="text"
              placeholder="https://xyz.trycloudflare.com or https://yourdomain.com"
              value={customPublicUrl}
              onChange={(e) => setCustomPublicUrl(e.target.value)}
              style={{ width: "320px" }}
            />
            <small style={{ display: "block", color: "#666" }}>
              Required so phones on cellular networks can reach the server.
            </small>
          </div>
        )}
      </section>

      <section style={{ marginTop: "1rem" }}>
        <h2>2. Start Session</h2>
        <button
          type="button"
          onClick={createTransferSession}
          disabled={loading || (!usePublicTunnel && !selectedAddress)}
        >
          {loading ? "Creating..." : "Generate QR Code"}
        </button>
      </section>

      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}

      <QRDisplay qrCode={qrCode} transferUrl={transferUrl} />
      <ConnectionStatus connected={connected} message={message} />

      {(progress > 0 || status !== "Idle") && (
        <TransferProgress progress={progress} status={status} />
      )}

      {sessionId && (
        <p>
          <strong>Session ID:</strong> {sessionId}
        </p>
      )}
    </main>
  );
}
