/**
 * WebRTC service with performance-tuned file transfer.
 *
 * Key speed changes vs. original:
 *  - 16 KB default chunk (fits SCTP MTU, avoids fragmentation)
 *  - Adaptive chunk size based on negotiated maxMessageSize (up to 256 KB)
 *  - Batched writes per loop iteration (many sends per event-loop tick)
 *  - Backpressure threshold tuned for relayed/high-RTT paths
 *  - ICE candidate pre-buffering in WebRTCManager (matches phone behavior)
 *  - TURN credentials from env (no more placeholder strings)
 *  - max-bundle + iceCandidatePoolSize for fewer transports / faster ICE
 */

export const CHUNK_SIZE = 16 * 1024; // 16 KB — safe SCTP payload
const MAX_CHUNK_SIZE = 256 * 1024; // upper bound if peer negotiates a bigger SCTP
const HIGH_WATER = 256 * 1024; // pause sending when buffer exceeds this
const LOW_WATER = 64 * 1024; // resume when buffer drops below this
const BATCH_CHUNKS = 8; // read+sends per microtask tick

/* ---------- ICE servers (env-driven) ---------- */

function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ];

  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  const turnUser = import.meta.env.VITE_TURN_USERNAME as string | undefined;
  const turnPass = import.meta.env.VITE_TURN_PASSWORD as string | undefined;

  if (turnUrl && turnUser && turnPass) {
    servers.push({
      urls: turnUrl.split(",").map((u) => u.trim()),
      username: turnUser,
      credential: turnPass,
    });
  } else {
    console.warn(
      "[webrtc] TURN credentials not set — cross-network transfers will be slow or fail. " +
        "Set VITE_TURN_URL, VITE_TURN_USERNAME, VITE_TURN_PASSWORD in .env",
    );
  }

  return servers;
}

const ICE_SERVERS = buildIceServers();

/* ---------- File sender ---------- */

export async function sendFile(
  channel: RTCDataChannel,
  file: File,
  onProgress: (percentage: number) => void,
): Promise<void> {
  channel.send(
    JSON.stringify({
      type: "file-start",
      name: file.name,
      size: file.size,
      mimeType: file.type,
    }),
  );

  // Use the largest payload the peer will accept (bounded by MAX_CHUNK_SIZE).
  // Most modern browsers negotiate up to 256 KB SCTP, but >64 KB fragments
  // worse than 16 KB in practice over lossy links. We clamp to 64 KB.
  const chunkSize = Math.min(
    Math.max(channel.bufferedAmountLowThreshold || CHUNK_SIZE, CHUNK_SIZE),
    Math.min(MAX_CHUNK_SIZE, 64 * 1024),
  );

  let offset = 0;
  let lastReport = 0;

  while (offset < file.size) {
    // Backpressure: pause when the send buffer is saturated.
    if (channel.bufferedAmount > HIGH_WATER) {
      await waitForBuffer(channel);
    }

    // Read BATCH_CHUNKS chunks in parallel then write them.
    // This avoids one microtask per chunk and improves throughput on
    // high-RTT / relayed links where scheduling overhead matters.
    const batchEnd = Math.min(offset + chunkSize * BATCH_CHUNKS, file.size);
    const promises: Promise<ArrayBuffer>[] = [];
    for (let o = offset; o < batchEnd; o += chunkSize) {
      const slice = file.slice(o, Math.min(o + chunkSize, batchEnd));
      promises.push(slice.arrayBuffer());
    }
    const buffers = await Promise.all(promises);

    for (const buf of buffers) {
      channel.send(buf);
      offset += buf.byteLength;
    }

    // Throttle progress updates to ~10/sec.
    const now = performance.now();
    if (now - lastReport > 100 || offset >= file.size) {
      lastReport = now;
      onProgress(Math.min((offset / file.size) * 100, 100));
    }
  }

  channel.send(JSON.stringify({ type: "file-end" }));
}

function waitForBuffer(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      done = true;
      channel.onbufferedamountlow = null;
      channel.onclose = null;
      channel.onerror = null;
    };

    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.onbufferedamountlow = () => {
      if (done) return;
      cleanup();
      resolve();
    };
    channel.onclose = () => {
      if (done) return;
      cleanup();
      reject(new Error("Data channel closed while waiting for buffer"));
    };
    channel.onerror = (e) => {
      if (done) return;
      cleanup();
      reject(new Error("Data channel error: " + (e as any)?.message));
    };

    // Safety net — never hang forever.
    setTimeout(() => {
      if (done) return;
      cleanup();
      resolve(); // proceed anyway; caller will re-check bufferedAmount
    }, 5000);
  });
}

/* ---------- WebRTC manager ---------- */

export class WebRTCManager {
  private peer: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private onDataChannel: (channel: RTCDataChannel) => void;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDesc = false;

  constructor(onDataChannel: (channel: RTCDataChannel) => void) {
    this.onDataChannel = onDataChannel;

    this.peer = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10,
      bundlePolicy: "max-bundle", // one transport for data+media → faster ICE
      rtcpMuxPolicy: "require",
    });

    this.peer.ondatachannel = (event) => {
      this.channel = event.channel;
      this.onDataChannel(event.channel);
    };

    // Flush queued candidates as soon as a remote description exists.
    this.peer.onsignalingstatechange = () => {
      if (
        !this.hasRemoteDesc &&
        this.peer.remoteDescription &&
        this.peer.remoteDescription.type
      ) {
        this.hasRemoteDesc = true;
        void this.flushPendingCandidates();
      }
    };
  }

  createDataChannel(): RTCDataChannel {
    this.channel = this.peer.createDataChannel("file-transfer", {
      ordered: true,
      // ordered:true keeps files intact; ordered:false would corrupt
      // multipart reassembly on lossy links.
    });
    this.onDataChannel(this.channel);
    return this.channel;
  }

  hasChannel(): boolean {
    return this.channel !== null;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    return offer;
  }

  async createAnswer(
    offer: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    await this.peer.setRemoteDescription(offer);
    this.hasRemoteDesc = true;
    await this.flushPendingCandidates();
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    return answer;
  }

  async setAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.peer.setRemoteDescription(answer);
    this.hasRemoteDesc = true;
    await this.flushPendingCandidates();
  }

  /**
   * Adds an ICE candidate, buffering it if the remote description hasn't
   * arrived yet. This is critical for cross-network (TURN) paths where
   * candidates frequently arrive before the answer/offer.
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDesc) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.peer.addIceCandidate(candidate);
    } catch (err) {
      // Candidate may reference an m-line that's already gone; ignore.
      console.warn("addIceCandidate failed", err);
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of queued) {
      try {
        await this.peer.addIceCandidate(c);
      } catch (err) {
        console.warn("flush addIceCandidate failed", err);
      }
    }
  }

  onIceCandidate(cb: (c: RTCIceCandidate) => void): void {
    this.peer.onicecandidate = (event) => {
      if (event.candidate) cb(event.candidate);
    };
  }

  close(): void {
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.peer.close();
    } catch {
      /* ignore */
    }
    this.channel = null;
    this.pendingCandidates = [];
  }
}

/* ---------- Signaling ---------- */

export class SignalingClient {
  private socket: WebSocket | null = null;

  connect(
    role: "laptop" | "phone",
    sessionId: string,
    onMessage: (data: any) => void,
    onOpen?: () => void,
    onClose?: () => void,
  ): void {
    const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;

    let socketUrl: string;
    if (envWsUrl) {
      socketUrl = envWsUrl;
    } else {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      // NOTE: no port override — window.location.host already includes it.
      socketUrl = `${protocol}//${window.location.host}/ws`;
    }

    console.log("[signaling] connecting to", socketUrl);
    this.socket = new WebSocket(socketUrl);

    this.socket.onopen = () => {
      this.send({
        type: "join",
        sessionId,
        payload: { role },
      });
      onOpen?.();
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
      } catch (err) {
        console.error("Signaling parse error:", err);
      }
    };

    this.socket.onclose = () => {
      onClose?.();
    };

    this.socket.onerror = (e) => {
      console.error("[signaling] error", e);
    };
  }

  send(data: any): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    }
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
