export type Role =
    | "laptop"
    | "phone";

export interface SignalMessage {
    type: string;
    sessionId: string;
    payload?: any;
}