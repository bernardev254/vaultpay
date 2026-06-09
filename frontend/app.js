const cfg = {
  appName: "VaultPay",
  contractAddress: "",
  chainId: "0x66eee",
  chainName: "Arbitrum Sepolia",
  rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  blockExplorerUrl: "https://sepolia.arbiscan.io",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  joinFeeWei: "2",
  ...(window.VAULTPAY_CONFIG || {}),
};

const ABI = {
  createSaving: "createSaving(string,uint256,uint8,bool)",
  getAccumulatedPool: "getAccumulatedPool()",
  getBitsaveUserCount: "getBitsaveUserCount()",
  getSavingDetails: "getSavingDetails(string)",
  getTokensBalance: "getTokensBalance()",
  getUserDetails: "getUserDetails()",
  incrementSaving: "incrementSaving(string)",
  joinBitsave: "joinBitsave(uint8[])",
  withdrawSavings: "withdrawSavings(string)",
};

const state = {
  account: "",
  chainId: "",
  user: null,
  vaults: [],
  selectedVaultId: "",
  view: "home",
  modal: "",
  tx: null,
  form: {},
};

const app = document.querySelector("#app");
const hasWallet = Boolean(window.ethereum);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MASK_64 = (1n << 64n) - 1n;
const textEncoder = new TextEncoder();

function rot(value, shift) {
  const n = BigInt(shift);
  return ((value << n) | (value >> (64n - n))) & MASK_64;
}

function keccakF(stateWords) {
  const rc = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
    0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
    0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
    0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
    0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
    0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
    0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const rotc = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
  const piln = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
  const bc = new Array(5).fill(0n);

  for (let round = 0; round < 24; round += 1) {
    for (let i = 0; i < 5; i += 1) {
      bc[i] = stateWords[i] ^ stateWords[i + 5] ^ stateWords[i + 10] ^ stateWords[i + 15] ^ stateWords[i + 20];
    }
    for (let i = 0; i < 5; i += 1) {
      const t = bc[(i + 4) % 5] ^ rot(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) stateWords[j + i] = (stateWords[j + i] ^ t) & MASK_64;
    }

    let t = stateWords[1];
    for (let i = 0; i < 24; i += 1) {
      const j = piln[i];
      const next = stateWords[j];
      stateWords[j] = rot(t, rotc[i]);
      t = next;
    }

    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i += 1) bc[i] = stateWords[j + i];
      for (let i = 0; i < 5; i += 1) {
        stateWords[j + i] = (bc[i] ^ ((~bc[(i + 1) % 5] & MASK_64) & bc[(i + 2) % 5])) & MASK_64;
      }
    }
    stateWords[0] = (stateWords[0] ^ rc[round]) & MASK_64;
  }
}

function keccak256(bytes) {
  const rate = 136;
  const stateWords = new Array(25).fill(0n);
  const input = Array.from(bytes);
  input.push(0x01);
  while (input.length % rate !== rate - 1) input.push(0);
  input.push(0x80);

  for (let offset = 0; offset < input.length; offset += rate) {
    for (let i = 0; i < rate / 8; i += 1) {
      let lane = 0n;
      for (let b = 0; b < 8; b += 1) lane |= BigInt(input[offset + i * 8 + b] || 0) << BigInt(8 * b);
      stateWords[i] ^= lane;
    }
    keccakF(stateWords);
  }

  const out = [];
  for (let i = 0; out.length < 32; i += 1) {
    for (let b = 0; b < 8 && out.length < 32; b += 1) out.push(Number((stateWords[i] >> BigInt(8 * b)) & 0xffn));
  }
  return out.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function selector(signature) {
  return keccak256(textEncoder.encode(signature)).slice(0, 8);
}

function cleanHex(hex) {
  return String(hex || "").replace(/^0x/, "");
}

function pad32(value) {
  return cleanHex(value).padStart(64, "0");
}

function uint256(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeString(value) {
  const hex = bytesToHex(textEncoder.encode(value));
  const paddedLength = Math.ceil(hex.length / 64) * 64;
  return uint256(hex.length / 2) + hex.padEnd(paddedLength, "0");
}

function encodeUint8Array(bytes) {
  return uint256(bytes.length) + Array.from(bytes).map((byte) => uint256(byte)).join("");
}

function calldata(name, args = []) {
  if (name === "joinBitsave") {
    const bytes = textEncoder.encode(args[0]);
    return "0x" + selector(ABI.joinBitsave) + uint256(32) + encodeUint8Array(bytes);
  }
  if (name === "createSaving") {
    return "0x" + selector(ABI.createSaving)
      + uint256(128)
      + uint256(args[1])
      + uint256(args[2])
      + uint256(args[3] ? 1 : 0)
      + encodeString(args[0]);
  }
  if (name === "incrementSaving") {
    return "0x" + selector(ABI.incrementSaving) + uint256(32) + encodeString(args[0]);
  }
  if (name === "withdrawSavings") {
    return "0x" + selector(ABI.withdrawSavings) + uint256(32) + encodeString(args[0]);
  }
  if (name === "getSavingDetails") {
    return "0x" + selector(ABI.getSavingDetails) + uint256(32) + encodeString(args[0]);
  }
  return "0x" + selector(ABI[name]);
}

function parseUnits(value, decimals = 18) {
  const normalized = String(value || "").trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Enter a valid amount.");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

function formatUnits(value, decimals = 18) {
  const wei = BigInt(value || 0);
  const base = 10n ** BigInt(decimals);
  const whole = wei / base;
  const fraction = (wei % base).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
}

function formatDate(seconds) {
  if (!seconds) return "Not set";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(Number(seconds) * 1000));
}

function vaultStatus(vault) {
  if (vault.withdrawn) return { label: "Withdrawn", type: "" };
  if (Number(vault.maturityTime) <= Math.floor(Date.now() / 1000)) return { label: "Matured", type: "success" };
  return { label: "Penalty applies", type: "warn" };
}

function storageKey() {
  return `vaultpay:v1:${cfg.contractAddress || ZERO_ADDRESS}:${state.chainId || cfg.chainId}:${state.account}`;
}

function loadVaults() {
  if (!state.account) return [];
  try {
    return JSON.parse(localStorage.getItem(storageKey()) || "[]");
  } catch {
    return [];
  }
}

function saveVaults() {
  localStorage.setItem(storageKey(), JSON.stringify(state.vaults));
}

function setTx(title, message, type = "") {
  state.tx = { title, message, type };
  render();
}

function clearTxSoon() {
  setTimeout(() => {
    state.tx = null;
    render();
  }, 5200);
}

async function request(method, params = []) {
  if (!window.ethereum) throw new Error("No wallet detected. Install a browser wallet to continue.");
  return window.ethereum.request({ method, params });
}

async function connectWallet() {
  const accounts = await request("eth_requestAccounts");
  state.account = accounts[0] || "";
  state.chainId = await request("eth_chainId");
  state.vaults = loadVaults();
  await refreshUser();
  state.view = "dashboard";
  render();
}

async function switchNetwork() {
  try {
    await request("wallet_switchEthereumChain", [{ chainId: cfg.chainId }]);
  } catch (error) {
    if (error.code !== 4902) throw error;
    await request("wallet_addEthereumChain", [{
      chainId: cfg.chainId,
      chainName: cfg.chainName,
      rpcUrls: [cfg.rpcUrl],
      blockExplorerUrls: [cfg.blockExplorerUrl],
      nativeCurrency: cfg.nativeCurrency,
    }]);
  }
  state.chainId = await request("eth_chainId");
  render();
}

async function ethCall(name, args = []) {
  if (!cfg.contractAddress) throw new Error("Set the contract address in frontend/config.js.");
  return request("eth_call", [{ from: state.account, to: cfg.contractAddress, data: calldata(name, args) }, "latest"]);
}

function decodeUint(hex) {
  return BigInt("0x" + cleanHex(hex).slice(0, 64));
}

function decodeUserDetails(hex) {
  const data = cleanHex(hex);
  const offset = Number(BigInt("0x" + data.slice(0, 64)));
  const id = BigInt("0x" + data.slice(64, 128));
  const address = "0x" + data.slice(128 + 24, 192);
  const start = offset * 2;
  const length = Number(BigInt("0x" + data.slice(start, start + 64)));
  const bytes = [];
  for (let i = 0; i < length; i += 1) {
    bytes.push(Number(BigInt("0x" + data.slice(start + 64 + i * 64, start + 128 + i * 64))));
  }
  return { name: new TextDecoder().decode(new Uint8Array(bytes)) || "VaultPay saver", id, address };
}

function decodeSavingDetails(hex) {
  const data = cleanHex(hex);
  return {
    safeMode: BigInt("0x" + data.slice(0, 64)) === 1n,
    amountWei: BigInt("0x" + data.slice(64, 128)).toString(),
    maturityTime: Number(BigInt("0x" + data.slice(128, 192))),
    penalty: Number(BigInt("0x" + data.slice(192, 256))),
    startTime: Number(BigInt("0x" + data.slice(256, 320))),
  };
}

async function refreshUser() {
  if (!state.account || !cfg.contractAddress) return;
  try {
    state.user = decodeUserDetails(await ethCall("getUserDetails"));
    await refreshVaultsFromChain();
  } catch {
    state.user = null;
  }
}

async function refreshVaultsFromChain() {
  if (!state.vaults.length || !cfg.contractAddress) return;
  const refreshed = [];
  for (const vault of state.vaults) {
    if (vault.withdrawn) {
      refreshed.push(vault);
      continue;
    }
    try {
      const onchain = decodeSavingDetails(await ethCall("getSavingDetails", [vault.name]));
      refreshed.push({ ...vault, ...onchain });
    } catch {
      refreshed.push(vault);
    }
  }
  state.vaults = refreshed;
  saveVaults();
}

async function sendContractTx(name, args, valueWei = 0n) {
  if (!cfg.contractAddress) throw new Error("Set the contract address in frontend/config.js.");
  if (!state.account) throw new Error("Connect your wallet first.");
  if (state.chainId?.toLowerCase() !== cfg.chainId.toLowerCase()) throw new Error(`Switch to ${cfg.chainName} first.`);

  setTx("Waiting for wallet", "Review the transaction in your wallet.");
  const hash = await request("eth_sendTransaction", [{
    from: state.account,
    to: cfg.contractAddress,
    data: calldata(name, args),
    value: "0x" + BigInt(valueWei).toString(16),
  }]);
  setTx("Transaction submitted", `${shortAddress(hash)} is confirming.`);

  for (let i = 0; i < 48; i += 1) {
    const receipt = await request("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status === "0x1") return hash;
      throw new Error("Transaction failed onchain.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  return hash;
}

async function joinVaultPay(event) {
  event.preventDefault();
  const userName = new FormData(event.currentTarget).get("userName") || "VaultPay saver";
  try {
    await sendContractTx("joinBitsave", [String(userName)], BigInt(cfg.joinFeeWei || 0));
    setTx("Joined VaultPay", "You can now create onchain savings vaults.", "success");
    await refreshUser();
  } catch (error) {
    setTx("Join failed", readableError(error), "error");
  }
  clearTxSoon();
}

async function createSaving(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    const name = String(data.get("name") || "").trim();
    const amountWei = parseUnits(data.get("amount"), cfg.nativeCurrency.decimals);
    const maturityTime = Math.floor(new Date(data.get("maturity")).getTime() / 1000);
    const penalty = Number(data.get("penalty"));
    const safeMode = data.get("safeMode") === "on";
    validateVault({ name, amountWei, maturityTime, penalty });
    await sendContractTx("createSaving", [name, maturityTime, penalty, safeMode], amountWei);
    state.vaults = [
      ...state.vaults.filter((vault) => vault.name.toLowerCase() !== name.toLowerCase()),
      { id: crypto.randomUUID(), name, amountWei: amountWei.toString(), maturityTime, penalty, safeMode, startTime: Math.floor(Date.now() / 1000) },
    ];
    await refreshVaultsFromChain();
    saveVaults();
    state.modal = "";
    setTx("Saving created", `${name} is now tracked in VaultPay.`, "success");
  } catch (error) {
    setTx("Create saving failed", readableError(error), "error");
  }
  clearTxSoon();
}

async function addFunds(event) {
  event.preventDefault();
  const vault = selectedVault();
  const data = new FormData(event.currentTarget);
  try {
    const amountWei = parseUnits(data.get("amount"), cfg.nativeCurrency.decimals);
    if (amountWei <= 0n) throw new Error("Amount must be greater than zero.");
    await sendContractTx("incrementSaving", [vault.name], amountWei);
    vault.amountWei = (BigInt(vault.amountWei) + amountWei).toString();
    await refreshVaultsFromChain();
    saveVaults();
    state.modal = "";
    setTx("Funds added", `${formatUnits(amountWei, cfg.nativeCurrency.decimals)} ${cfg.nativeCurrency.symbol} added to ${vault.name}.`, "success");
  } catch (error) {
    setTx("Add funds failed", readableError(error), "error");
  }
  clearTxSoon();
}

async function withdraw(event) {
  event.preventDefault();
  const vault = selectedVault();
  try {
    await sendContractTx("withdrawSavings", [vault.name], 0n);
    vault.withdrawn = true;
    saveVaults();
    state.modal = "";
    setTx("Withdrawal complete", `${vault.name} has been marked withdrawn.`, "success");
  } catch (error) {
    setTx("Withdraw failed", readableError(error), "error");
  }
  clearTxSoon();
}

function validateVault({ name, amountWei, maturityTime, penalty }) {
  if (!name) throw new Error("Saving name is required.");
  if (amountWei <= 0n) throw new Error("Amount must be greater than zero.");
  if (!Number.isFinite(maturityTime) || maturityTime <= Math.floor(Date.now() / 1000)) throw new Error("Maturity date must be in the future.");
  if (!Number.isInteger(penalty) || penalty < 0 || penalty > 100) throw new Error("Penalty must be between 0 and 100%.");
}

function selectedVault() {
  return state.vaults.find((vault) => vault.id === state.selectedVaultId) || state.vaults[0];
}

function readableError(error) {
  if (error?.code === 4001) return "Transaction rejected in wallet.";
  return error?.message || "Something went wrong.";
}

function totalSaved() {
  return state.vaults.filter((vault) => !vault.withdrawn).reduce((sum, vault) => sum + BigInt(vault.amountWei || 0), 0n);
}

function readyCount() {
  const now = Math.floor(Date.now() / 1000);
  return state.vaults.filter((vault) => !vault.withdrawn && Number(vault.maturityTime) <= now).length;
}

function html(strings, ...values) {
  return strings.map((part, index) => part + (values[index] ?? "")).join("");
}

function renderHeader() {
  const wrongNetwork = state.account && state.chainId?.toLowerCase() !== cfg.chainId.toLowerCase();
  return html`
    <header class="topbar shell">
      <button class="brand brand-button" data-action="home" aria-label="Go to VaultPay home">
        <div class="logo" aria-hidden="true">V</div>
        <div>
          <div class="brand-name">VaultPay</div>
          <div class="tagline">Save like PayPal. Settle on Arbitrum.</div>
        </div>
      </button>
      <div class="actions">
        ${state.account ? `<span class="pill"><span class="dot ${wrongNetwork ? "warn" : ""}"></span>${wrongNetwork ? "Wrong network" : cfg.chainName}</span>` : ""}
        ${state.account ? `<span class="pill">${shortAddress(state.account)}</span>` : ""}
        ${wrongNetwork ? `<button class="secondary" data-action="switch">Switch Network</button>` : ""}
        ${state.account ? `<button class="primary" data-action="${state.view === "home" ? "dashboard" : "create"}">${state.view === "home" ? "Dashboard" : "Create Saving"}</button>` : `<button class="primary" data-action="connect">Connect Wallet</button>`}
      </div>
    </header>
  `;
}

function renderHome() {
  return html`
    ${renderHeader()}
    <main class="shell hero">
      <section>
        <div class="eyebrow">Built with Arbitrum Stylus + Rust</div>
        <h1>PayPal-style savings, powered by Arbitrum.</h1>
        <p>Create simple crypto savings vaults, add funds over time, and withdraw through transparent onchain rules.</p>
        <div class="actions" style="margin-top: 26px; justify-content: flex-start;">
          <button class="primary" data-action="${state.account ? "dashboard" : "connect"}">${state.account ? "Open Dashboard" : "Connect Wallet"}</button>
          <button class="secondary" data-action="demo">View Demo Flow</button>
        </div>
      </section>
      <aside class="hero-panel" aria-label="VaultPay preview">
        <span class="badge success">Simple savings. Onchain discipline.</span>
        <div class="muted" style="margin-top: 18px;">Total Saved</div>
        <div class="balance-figure">2.40 ${cfg.nativeCurrency.symbol}</div>
        <div class="mini-row">
          <div class="metric"><span>Active Vaults</span><strong>3</strong></div>
          <div class="metric"><span>Ready</span><strong>1</strong></div>
        </div>
      </aside>
    </main>
  `;
}

function renderJoin() {
  return html`
    <section class="join-card">
      <button class="back-button" data-action="home" aria-label="Back to home"><span aria-hidden="true">&larr;</span> Home</button>
      <h2>Join VaultPay</h2>
      <p>Join once to start creating onchain savings vaults.</p>
      <form data-submit="join">
        <label>Your display name
          <input name="userName" autocomplete="name" placeholder="Ada" required />
        </label>
        <div class="confirm">
          <div class="line"><span>Joining fee</span><strong>${cfg.joinFeeWei} wei</strong></div>
          <div class="line"><span>Contract</span><strong>${cfg.contractAddress ? shortAddress(cfg.contractAddress) : "Not configured"}</strong></div>
        </div>
        <button class="primary" type="submit">Join VaultPay</button>
      </form>
    </section>
  `;
}

function renderDashboard() {
  const activeVaults = state.vaults.filter((vault) => !vault.withdrawn);
  return html`
    ${renderHeader()}
    <main class="shell dashboard">
      <nav class="page-nav" aria-label="Page navigation">
        <button class="back-button" data-action="home" aria-label="Back to home"><span aria-hidden="true">&larr;</span> Home</button>
      </nav>
      ${!cfg.contractAddress ? `<div class="notice">Set <strong>contractAddress</strong> in <strong>frontend/config.js</strong> before sending real transactions.</div>` : ""}
      ${state.account && !state.user ? renderJoin() : ""}
      <section class="section-head">
        <div>
          <div class="eyebrow">Dashboard</div>
          <h2>Your savings</h2>
        </div>
        <button class="primary" data-action="create">Create Saving</button>
      </section>
      <section class="summary-grid">
        <div class="summary-card"><span class="muted">Total Saved</span><strong>${formatUnits(totalSaved(), cfg.nativeCurrency.decimals)} ${cfg.nativeCurrency.symbol}</strong></div>
        <div class="summary-card"><span class="muted">Active Vaults</span><strong>${activeVaults.length}</strong></div>
        <div class="summary-card"><span class="muted">Matured / Ready</span><strong>${readyCount()}</strong></div>
      </section>
      <section class="section-head">
        <h2>Vaults</h2>
      </section>
      ${activeVaults.length ? `<div class="vault-grid">${activeVaults.map(renderVaultCard).join("")}</div>` : renderEmpty()}
      ${state.selectedVaultId ? renderDetails() : ""}
    </main>
  `;
}

function renderVaultCard(vault) {
  const status = vaultStatus(vault);
  return html`
    <article class="vault-card">
      <div class="card-title">
        <h3>${escapeHtml(vault.name)}</h3>
        <span class="badge ${status.type}">${status.label}</span>
      </div>
      <div class="amount">${formatUnits(vault.amountWei, cfg.nativeCurrency.decimals)} ${cfg.nativeCurrency.symbol}</div>
      <div class="card-lines">
        <div class="line"><span>Safe mode</span><strong>${vault.safeMode ? "On" : "Off"}</strong></div>
        <div class="line"><span>Matures on</span><strong>${formatDate(vault.maturityTime)}</strong></div>
        <div class="line"><span>Penalty</span><strong>${vault.penalty}%</strong></div>
      </div>
      <div class="actions" style="justify-content: flex-start;">
        <button class="secondary" data-action="view" data-id="${vault.id}">View</button>
        <button class="ghost" data-action="add" data-id="${vault.id}">Add Funds</button>
      </div>
    </article>
  `;
}

function renderEmpty() {
  return html`
    <div class="empty">
      <div>
        <span class="badge">New saver</span>
        <h3>No savings yet</h3>
        <p>Create your first savings vault and start building onchain discipline.</p>
        <button class="primary" data-action="create">Create Saving</button>
      </div>
    </div>
  `;
}

function renderDetails() {
  const vault = selectedVault();
  if (!vault) return "";
  const status = vaultStatus(vault);
  const matured = status.type === "success";
  return html`
    <section class="details">
      <button class="back-button" data-action="back" aria-label="Back to dashboard"><span aria-hidden="true">&larr;</span> Dashboard</button>
      <div class="section-head">
        <div>
          <h2>${escapeHtml(vault.name)}</h2>
          <div class="muted">Your savings are tracked onchain.</div>
        </div>
        <span class="badge ${status.type}">${matured ? "Matured" : "Early withdrawal penalty applies"}</span>
      </div>
      <div class="details-grid">
        <div class="detail-box">
          <div class="muted">Amount saved</div>
          <div class="balance-figure">${formatUnits(vault.amountWei, cfg.nativeCurrency.decimals)} ${cfg.nativeCurrency.symbol}</div>
          <div class="actions" style="justify-content: flex-start;">
            <button class="primary" data-action="withdraw" data-id="${vault.id}">${matured ? "Withdraw" : "Withdraw Early"}</button>
            <button class="secondary" data-action="add" data-id="${vault.id}">Add Funds</button>
          </div>
        </div>
        <div class="detail-box card-lines">
          <div class="line"><span>Safe mode</span><strong>${vault.safeMode ? "On" : "Off"}</strong></div>
          <div class="line"><span>Start date</span><strong>${formatDate(vault.startTime)}</strong></div>
          <div class="line"><span>Maturity date</span><strong>${formatDate(vault.maturityTime)}</strong></div>
          <div class="line"><span>Penalty percentage</span><strong>${vault.penalty}%</strong></div>
        </div>
      </div>
    </section>
  `;
}

function renderCreateModal() {
  const minDate = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);
  return modal("Create Saving", html`
    <form data-submit="create">
      <label>Saving name
        <input name="name" placeholder="Emergency Fund" maxlength="48" required />
      </label>
      <div class="form-row">
        <label>Amount
          <input name="amount" inputmode="decimal" placeholder="0.05" required />
        </label>
        <label>Penalty percentage
          <input name="penalty" type="number" min="0" max="100" step="1" value="5" required />
        </label>
      </div>
      <label>Maturity date and time
        <input name="maturity" type="datetime-local" min="${minDate}" required />
      </label>
      <label class="toggle">
        <span><strong>Safe mode</strong><span class="muted"> Keep this saving protected until maturity.</span></span>
        <input name="safeMode" type="checkbox" checked />
      </label>
      <div class="confirm">
        <div class="line"><span>Transaction</span><strong>Create saving</strong></div>
        <div class="line"><span>Network</span><strong>${cfg.chainName}</strong></div>
      </div>
      <button class="primary" type="submit">Create Saving</button>
    </form>
  `);
}

function renderAddModal() {
  const vault = selectedVault();
  return modal("Add Funds", html`
    <form data-submit="add">
      <div class="confirm">
        <div class="line"><span>Selected saving</span><strong>${escapeHtml(vault.name)}</strong></div>
        <div class="line"><span>Current amount</span><strong>${formatUnits(vault.amountWei, cfg.nativeCurrency.decimals)} ${cfg.nativeCurrency.symbol}</strong></div>
      </div>
      <label>Amount to add
        <input name="amount" inputmode="decimal" placeholder="0.02" required />
      </label>
      <button class="primary" type="submit">Add Funds</button>
    </form>
  `);
}

function renderWithdrawModal() {
  const vault = selectedVault();
  const status = vaultStatus(vault);
  const matured = status.type === "success";
  return modal(matured ? "Withdraw" : "Withdraw Early", html`
    <form data-submit="withdraw">
      <div class="confirm">
        <div class="line"><span>Saving</span><strong>${escapeHtml(vault.name)}</strong></div>
        <div class="line"><span>Amount</span><strong>${formatUnits(vault.amountWei, cfg.nativeCurrency.decimals)} ${cfg.nativeCurrency.symbol}</strong></div>
        <div class="line"><span>Maturity</span><strong>${formatDate(vault.maturityTime)}</strong></div>
      </div>
      ${matured ? `<p class="muted">This saving has reached maturity and is ready to withdraw.</p>` : `<div class="notice">This saving has not reached maturity. Withdrawing now may apply a penalty of ${vault.penalty}%.</div>`}
      ${matured ? "" : `<label class="toggle"><span>I understand the early withdrawal penalty may apply.</span><input type="checkbox" required /></label>`}
      <button class="${matured ? "primary" : "danger"}" type="submit">${matured ? "Withdraw" : "Withdraw Early"}</button>
    </form>
  `);
}

function modal(title, body) {
  return html`
    <div class="modal-backdrop">
      <section class="modal" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="modal-head">
          <div class="modal-title">
            <button class="icon-button" data-action="close" aria-label="Back">
              <span aria-hidden="true">&larr;</span>
            </button>
            <h2>${title}</h2>
          </div>
          <button class="icon-button" data-action="close" aria-label="Close">x</button>
        </div>
        ${body}
      </section>
    </div>
  `;
}

function renderToast() {
  if (!state.tx) return "";
  return html`
    <aside class="toast">
      <div>
        <strong class="${state.tx.type === "error" ? "error" : ""}">${state.tx.title}</strong>
        <span class="muted">${state.tx.message}</span>
      </div>
      <button class="toast-close" data-action="closeToast" aria-label="Close notification">x</button>
    </aside>
  `;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function render() {
  const showDashboard = state.account && state.view !== "home";
  app.innerHTML = html`
    <div class="app">
      ${showDashboard ? renderDashboard() : renderHome()}
      ${state.modal === "create" ? renderCreateModal() : ""}
      ${state.modal === "add" ? renderAddModal() : ""}
      ${state.modal === "withdraw" ? renderWithdrawModal() : ""}
      ${renderToast()}
    </div>
  `;
}

app.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === "home") {
      state.view = "home";
      state.modal = "";
      state.selectedVaultId = "";
      render();
    }
    if (action === "dashboard") {
      if (!state.account) {
        await connectWallet();
      } else {
        state.view = "dashboard";
        state.modal = "";
        render();
      }
    }
    if (action === "connect") await connectWallet();
    if (action === "switch") await switchNetwork();
    if (action === "demo") {
      state.account = "0x1111111111111111111111111111111111111111";
      state.chainId = cfg.chainId;
      state.user = { name: "Demo saver", id: 1n, address: state.account };
      state.vaults = [{
        id: "demo-emergency",
        name: "Emergency Fund",
        amountWei: parseUnits("0.25", cfg.nativeCurrency.decimals).toString(),
        maturityTime: Math.floor(Date.now() / 1000) + 86400 * 14,
        penalty: 5,
        safeMode: true,
        startTime: Math.floor(Date.now() / 1000) - 86400,
      }];
      state.view = "dashboard";
      render();
    }
    if (action === "create") {
      state.view = state.account ? "dashboard" : state.view;
      state.modal = "create";
      render();
    }
    if (action === "view") {
      state.selectedVaultId = target.dataset.id;
      render();
    }
    if (action === "add") {
      state.selectedVaultId = target.dataset.id;
      state.modal = "add";
      render();
    }
    if (action === "withdraw") {
      state.selectedVaultId = target.dataset.id;
      state.modal = "withdraw";
      render();
    }
    if (action === "back") {
      state.selectedVaultId = "";
      render();
    }
    if (action === "close") {
      state.modal = "";
      render();
    }
    if (action === "closeToast") {
      state.tx = null;
      render();
    }
  } catch (error) {
    setTx("Action failed", readableError(error), "error");
    clearTxSoon();
  }
});

app.addEventListener("click", (event) => {
  if (event.target.classList.contains("modal-backdrop")) {
    state.modal = "";
    render();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.modal) {
    state.modal = "";
    render();
  }
});

app.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-submit]");
  if (!form) return;
  const submit = form.dataset.submit;
  if (submit === "join") joinVaultPay(event);
  if (submit === "create") createSaving(event);
  if (submit === "add") addFunds(event);
  if (submit === "withdraw") withdraw(event);
});

if (hasWallet) {
  window.ethereum.request({ method: "eth_accounts" }).then(async (accounts) => {
    if (accounts[0]) {
      state.account = accounts[0];
      state.chainId = await request("eth_chainId");
      state.vaults = loadVaults();
      await refreshUser();
    }
    render();
  }).catch(render);

  window.ethereum.on?.("accountsChanged", async (accounts) => {
    state.account = accounts[0] || "";
    state.user = null;
    state.selectedVaultId = "";
    state.vaults = loadVaults();
    if (state.account) await refreshUser();
    render();
  });

  window.ethereum.on?.("chainChanged", async (chainId) => {
    state.chainId = chainId;
    state.vaults = loadVaults();
    await refreshUser();
    render();
  });
}

render();
