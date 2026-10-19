interface QRDisplayProps {
  qrCode: string | null;
  transferUrl: string | null;
}

export default function QRDisplay({ qrCode, transferUrl }: QRDisplayProps) {
  if (!qrCode || !transferUrl) {
    return (
      <section className="qr-card">
        <h2>Connect your phone</h2>
        <p>Generate a QR code to start a transfer.</p>
      </section>
    );
  }

  return (
    <section className="qr-card">
      <h2>Scan to connect</h2>

      <img
        src={qrCode}
        alt="QR code for file transfer"
        width={240}
        height={240}
      />

      <p>Open your phone camera and scan this code.</p>

      <a href={transferUrl} target="_blank" rel="noreferrer">
        {transferUrl}
      </a>
    </section>
  );
}
