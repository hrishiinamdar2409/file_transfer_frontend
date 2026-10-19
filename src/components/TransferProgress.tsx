interface TransferProgressProps {
  progress: number;
  status: string;
}

export default function TransferProgress({
  progress,
  status,
}: TransferProgressProps) {
  const safeProgress = Math.max(0, Math.min(100, progress));

  return (
    <section className="transfer-progress">
      <h2>File transfer</h2>

      <p>{status}</p>

      <progress
        value={safeProgress}
        max={100}
        aria-label="File transfer progress"
      />

      <p>{Math.round(safeProgress)}% complete</p>
    </section>
  );
}
