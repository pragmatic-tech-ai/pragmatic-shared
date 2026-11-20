/**
 * The shape of Paddle's ids the contract carries as references (`sub_…`, `txn_…`, `pri_…`, events `evt_…`): never
 * amounts. Simulated notification events (Paddle's webhook simulator) carry `ntfsim` before the three-letter kind
 * (`ntfsimevt_…`), and are signed like real ones.
 */
export class PaddleReference
{
    public static readonly IdPattern = /^(?:ntfsim)?[a-z]{3}_[a-z0-9]{10,64}$/
    public static readonly UrlPattern = /^https:\/\/[^\s]+$/
    public static readonly MaxUrlLength = 2048
}
