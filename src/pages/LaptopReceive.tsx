import {
    useState
} from "react";

import QRCode from "qrcode";

export default function LaptopReceive() {

    const [
        sessionId,
        setSessionId
    ] = useState<string | null>(null);

    const [
        qr,
        setQr
    ] = useState<string | null>(null);

    async function createSession() {

        const response =
            await fetch("/api/session", {
                method: "POST"
            });

        const data =
            await response.json();

        const id =
            data.sessionId;

        setSessionId(id);

        const url =
            `${window.location.origin}/join/${id}`;

        const qrImage =
            await QRCode.toDataURL(url);

        setQr(qrImage);
    }

    return (

        <div>

            <h1>
                Receive File From Phone
            </h1>

            {!sessionId && (

                <button
                    onClick={createSession}
                >
                    Generate QR
                </button>

            )}

            {sessionId && (

                <>

                    <p>
                        Scan this QR with
                        your phone
                    </p>

                    {qr && (
                        <img
                            src={qr}
                            alt="Transfer QR"
                            width={300}
                        />
                    )}

                    <p>
                        Session:
                        {sessionId}
                    </p>

                    <p>
                        Waiting for phone...
                    </p>

                </>

            )}

        </div>

    );
}