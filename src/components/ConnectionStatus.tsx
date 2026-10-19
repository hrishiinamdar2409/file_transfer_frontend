interface ConnectionStatusProps {
  connected: boolean;
  message?: string;
}

export default function ConnectionStatus({
  connected,
  message,
}: ConnectionStatusProps) {
  return (
    <section className="connection-status">
      <span
        aria-hidden="true"
        className={connected ? "status-dot connected" : "status-dot"}
      />

      <strong>{connected ? "Connected" : "Not connected"}</strong>

      <p>
        {message ??
          (connected
            ? "Your devices are connected."
            : "Scan the QR code and wait for your phone to connect.")}
      </p>
    </section>
  );
}
