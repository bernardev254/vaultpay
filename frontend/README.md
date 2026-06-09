# VaultPay Frontend

Dependency-free demo frontend for the Bitsave Arbitrum Stylus contract.

## Run

From the repository root:

```bash
python3 -m http.server 5173 --directory frontend
```

Then open `http://localhost:5173`.

## Configure

Edit `frontend/config.js`:

- `contractAddress`: deployed Stylus contract address
- `chainId`: Arbitrum chain id as hex, for example `0xa4b1` for Arbitrum One or `0x66eee` for Arbitrum Sepolia
- `rpcUrl`: chain RPC URL
- `joinFeeWei`: minimum join fee in wei

The current ABI does not expose a savings list/details view, so VaultPay remembers created vault metadata in browser storage per wallet and contract while still sending real join, create, add funds, and withdraw transactions to the Stylus contract.
