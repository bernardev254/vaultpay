export const config = {
  appName: import.meta.env.VITE_APP_NAME || "VaultPay",
  contractAddress:
    import.meta.env.VITE_CONTRACT_ADDRESS ||
    "0x480a1d5f59ed23a0f96d36862a73913bffd14601",
  chainId: "0x66eee",
  chainIdDecimal: Number(import.meta.env.VITE_CHAIN_ID || 421614),
  chainName: "Arbitrum Sepolia",
  rpcUrl:
    import.meta.env.VITE_RPC_URL ||
    "https://sepolia-rollup.arbitrum.io/rpc",
  blockExplorerUrl: "https://sepolia.arbiscan.io",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  joinFeeWei: import.meta.env.VITE_JOIN_FEE_WEI || "2",
};
