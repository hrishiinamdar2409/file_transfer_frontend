import { useState } from "react";

interface FilePickerProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

export default function FilePicker({
  onFileSelected,
  disabled = false,
}: FilePickerProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);
    onFileSelected(file);
  }

  return (
    <section className="file-picker">
      <h2>Select a file</h2>

      <label htmlFor="transfer-file">
        Screenshot, video, document, or another file
      </label>

      <input
        id="transfer-file"
        type="file"
        accept="*/*"
        onChange={handleFileChange}
        disabled={disabled}
      />

      {selectedFile && (
        <div>
          <p>
            <strong>Name:</strong> {selectedFile.name}
          </p>
          <p>
            <strong>Size:</strong>{" "}
            {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
          </p>
          <p>
            <strong>Type:</strong> {selectedFile.type || "Unknown"}
          </p>
        </div>
      )}
    </section>
  );
}
