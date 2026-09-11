export type NetworkAddressV1 = Readonly<{family: "ipv4"; bytesHex: string}> |
  Readonly<{family: "ipv6"; bytesHex: string}>;
