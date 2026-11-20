/** The shape of Paddle's entity ids the contract carries as references (`sub_…`, `txn_…`, `pri_…`): never amounts. */
export class PaddleReference
{
    public static readonly IdPattern = /^[a-z]{3}_[a-z0-9]{10,64}$/
    public static readonly UrlPattern = /^https:\/\/[^\s]+$/
    public static readonly MaxUrlLength = 2048
}
