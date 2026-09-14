/** Non-secret scalar observations retained by the Host-owned append-only journal. */
export type OrdinarySessionObservation = Readonly<Record<string, string | number | boolean | null | undefined>>;
