import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { WebRTCManager, SignalingClient, sendFile } from "../services/webrtc";

export default function PhoneSend() {
  const { sessionId } = useParams<{ sessionId: string }>();

  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("Connecting...");
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState(0);
  const [sending, setSending] = useState(false);
  const [speedMbps, setSpeedMbps] = useState<number | null>(null);

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const offerStartedRef = useRef(false);
  const sendStartRef = useRef<number>(0);

  useEffect(() => {
    if (!sessionId) {
      setStatus("Missing session ID in URL");
      return;
    }

    let cancelled = false;
    offerStartedRef.current = false;

    const signaling = new SignalingClient();
    signalingRef.current = signaling;

    const webrtc = new WebRTCManager((channel) => {
      channelRef.current = channel;
      channel.binaryType = "arraybuffer";

      channel.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        setStatus("Connected! Ready to transfer.");
      };

      channel.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        setStatus("Disconnected from PC");
      };
    });

    webrtcRef.current = webrtc;

    webrtc.onIceCandidate((candidate) => {
      signaling.send({
        type: "ice-candidate",
        sessionId,
        payload: candidate.toJSON(),
      });
    });

    async function startOffer() {
      if (cancelled || offerStartedRef.current) return;
      offerStartedRef.current = true;

      if (!webrtcRef.current) return;
      webrtcRef.current.createDataChannel();
      const offer = await webrtcRef.current.createOffer();
      signaling.send({
        type: "offer",
        sessionId,
        payload: offer,
      });
    }

    signaling.connect(
      "phone",
      sessionId,
      async (data) => {
        if (cancelled) return;

        if (data.type === "answer") {
          await webrtc.setAnswer(data.payload);
        } else if (data.type === "ice-candidate") {
          // WebRTCManager now queues internally.
          await webrtc.addIceCandidate(data.payload);
        } else if (data.type === "peer-joined") {
          setStatus("PC detected. Establishing connection...");
          await startOffer();
        } else if (data.type === "error") {
          setStatus(`Error: ${data.message}`);
        }
      },
      () => {
        setStatus("Signaling connected. Waiting for PC...");
      },
    );

    return () => {
      cancelled = true;
      signaling.close();
      webrtc.close();
      signalingRef.current = null;
      webrtcRef.current = null;
      channelRef.current = null;
    };
  }, [sessionId]);

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setStatus("File selected. Tap Send.");
    setSpeedMbps(null);
  }

  async function handleSend() {
    if (!file || !channelRef.current) return;

    setSending(true);
    setProgress(0);
    setSpeedMbps(null);
    setStatus("Sending...");
    sendStartRef.current = performance.now();

    try {
      await sendFile(channelRef.current, file, (p) => {
        setProgress(p);
        const elapsedSec = (performance.now() - sendStartRef.current) / 1000;
        if (elapsedSec > 0.2) {
          const bytesSent = (p / 100) * file.size;
          setSpeedMbps((bytesSent * 8) / (elapsedSec * 1_000_000));
        }
      });
      const elapsedSec = (performance.now() - sendStartRef.current) / 1000;
      const mbps = (file.size * 8) / (elapsedSec * 1_000_000);
      setSpeedMbps(mbps);
      setStatus(`File sent successfully! (${mbps.toFixed(2)} Mbps)`);
    } catch (err) {
      setStatus(
        `Send failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="phone-send" style={{ padding: "1.5rem" }}>
      <h1>Send File</h1>
      <p>
        Session: <code>{sessionId}</code>
      </p>
      <p>
        <strong>Status:</strong> {status}
      </p>

      <input
        type="file"
        onChange={handleFile}
        disabled={!connected || sending}
      />

      {file && (
        <div style={{ marginTop: "1rem" }}>
          <p>
            <strong>Name:</strong> {file.name}
          </p>
          <p>
            <strong>Size:</strong> {(file.size / (1024 * 1024)).toFixed(2)} MB
          </p>

          <button
            type="button"
            onClick={handleSend}
            disabled={!connected || sending}
          >
            {sending ? "Sending..." : "Send File"}
          </button>
        </div>
      )}

      {progress > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <progress value={progress} max={100} style={{ width: "100%" }} />
          <p>
            {Math.round(progress)}%
            {speedMbps !== null && ` — ${speedMbps.toFixed(2)} Mbps`}
          </p>
        </div>
      )}
    </div>
  );
}
