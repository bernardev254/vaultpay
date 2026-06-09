import { useEffect, useMemo, useState } from "react";
import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseUnits,
} from "viem";
import { config as cfg } from "./config.js";

const abi = [
  {
    type: "function",
    name: "getUserDetails",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint8[]" },
      { type: "uint256" },
      { type: "address" },
    ],
  },
  {
    type: "function",
    name: "getSavingDetails",
    stateMutability: "view",
    inputs: [{ name: "name_of_saving", type: "string" }],
    outputs: [
      { type: "bool" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint8" },
      { type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "joinBitsave",
    stateMutability: "payable",
    inputs: [{ name: "user_name", type: "uint8[]" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "createSaving",
    stateMutability: "payable",
    inputs: [
      { name: "name_of_saving", type: "string" },
      { name: "maturity_time", type: "uint256" },
      { name: "penalty_perc", type: "uint8" },
      { name: "use_safe_mode", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "incrementSaving",
    stateMutability: "payable",
    inputs: [{ name: "name_of_saving", type: "string" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawSavings",
    stateMutability: "nonpayable",
    inputs: [{ name: "name_of_saving", type: "string" }],
    outputs: [{ type: "uint256" }],
  },
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
}

function toHexValue(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function formatAmount(value) {
  return `${formatUnits(BigInt(value || 0), cfg.nativeCurrency.decimals)} ${cfg.nativeCurrency.symbol}`;
}

function formatDate(seconds) {
  if (!seconds) return "Not set";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(Number(seconds) * 1000));
}

function readableError(error) {
  if (error?.code === 4001) return "Transaction rejected in wallet.";
  if (error?.shortMessage) return error.shortMessage;
  return error?.message || "Something went wrong.";
}

function storageKey(account, chainId) {
  return `vaultpay:v2:${cfg.contractAddress}:${chainId || cfg.chainId}:${account}`;
}

function statusFor(vault) {
  if (vault.withdrawn) return { label: "Withdrawn", kind: "neutral" };
  if (Number(vault.maturityTime) <= Math.floor(Date.now() / 1000)) {
    return { label: "Matured", kind: "success" };
  }
  return { label: "Penalty applies", kind: "warning" };
}

function App() {
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState("");
  const [user, setUser] = useState(null);
  const [vaults, setVaults] = useState([]);
  const [view, setView] = useState("home");
  const [modal, setModal] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [tx, setTx] = useState(null);

  const hasWallet = typeof window !== "undefined" && Boolean(window.ethereum);
  const wrongNetwork = account && chainId?.toLowerCase() !== cfg.chainId.toLowerCase();
  const activeVaults = vaults.filter((vault) => !vault.withdrawn);
  const selectedVault = vaults.find((vault) => vault.id === selectedId) || null;
  const totalSaved = useMemo(
    () => activeVaults.reduce((sum, vault) => sum + BigInt(vault.amountWei || 0), 0n),
    [activeVaults],
  );
  const readyCount = activeVaults.filter(
    (vault) => Number(vault.maturityTime) <= Math.floor(Date.now() / 1000),
  ).length;

  function saveVaults(nextVaults, nextAccount = account, nextChainId = chainId) {
    setVaults(nextVaults);
    if (nextAccount) {
      localStorage.setItem(storageKey(nextAccount, nextChainId), JSON.stringify(nextVaults));
    }
  }

  function loadVaults(nextAccount, nextChainId) {
    if (!nextAccount) return [];
    try {
      return JSON.parse(localStorage.getItem(storageKey(nextAccount, nextChainId)) || "[]");
    } catch {
      return [];
    }
  }

  async function request(method, params = []) {
    if (!window.ethereum) throw new Error("No wallet detected. Install a browser wallet to continue.");
    return window.ethereum.request({ method, params });
  }

  async function ethCall(functionName, args = []) {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await request("eth_call", [
      { from: account || undefined, to: cfg.contractAddress, data },
      "latest",
    ]);
    return decodeFunctionResult({ abi, functionName, data: result });
  }

  async function getGasFees() {
    const fallbackPriorityFee = 100_000_000n;
    try {
      const block = await request("eth_getBlockByNumber", ["latest", false]);
      const baseFee = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n;
      const priorityFee = fallbackPriorityFee;
      return {
        maxPriorityFeePerGas: toHexValue(priorityFee),
        maxFeePerGas: toHexValue(baseFee * 3n + priorityFee),
      };
    } catch {
      return {
        maxPriorityFeePerGas: toHexValue(fallbackPriorityFee),
        maxFeePerGas: toHexValue(1_000_000_000n),
      };
    }
  }

  async function refreshUser(nextVaults = vaults) {
    if (!account || !cfg.contractAddress) return;
    try {
      const [nameBytes, id, address] = await ethCall("getUserDetails");
      setUser({
        name: decoder.decode(new Uint8Array(nameBytes.map(Number))) || "VaultPay saver",
        id,
        address,
      });
      await refreshVaults(nextVaults);
    } catch {
      setUser(null);
    }
  }

  async function refreshVaults(seedVaults = vaults) {
    const refreshed = [];
    for (const vault of seedVaults) {
      if (vault.withdrawn) {
        refreshed.push(vault);
        continue;
      }
      try {
        const [safeMode, amountWei, maturityTime, penalty, startTime] = await ethCall(
          "getSavingDetails",
          [vault.name],
        );
        refreshed.push({
          ...vault,
          safeMode,
          amountWei: amountWei.toString(),
          maturityTime: Number(maturityTime),
          penalty: Number(penalty),
          startTime: Number(startTime),
        });
      } catch {
        refreshed.push(vault);
      }
    }
    saveVaults(refreshed);
  }

  async function connectWallet() {
    const accounts = await request("eth_requestAccounts");
    const nextAccount = accounts[0] || "";
    const nextChainId = await request("eth_chainId");
    setAccount(nextAccount);
    setChainId(nextChainId);
    const localVaults = loadVaults(nextAccount, nextChainId);
    setVaults(localVaults);
    setView("dashboard");
  }

  async function switchNetwork() {
    try {
      await request("wallet_switchEthereumChain", [{ chainId: cfg.chainId }]);
    } catch (error) {
      if (error.code !== 4902) throw error;
      await request("wallet_addEthereumChain", [
        {
          chainId: cfg.chainId,
          chainName: cfg.chainName,
          rpcUrls: [cfg.rpcUrl],
          blockExplorerUrls: [cfg.blockExplorerUrl],
          nativeCurrency: cfg.nativeCurrency,
        },
      ]);
    }
    setChainId(await request("eth_chainId"));
  }

  async function sendTx(functionName, args = [], value = 0n, labels = {}) {
    if (!cfg.contractAddress) throw new Error("Contract address is not configured.");
    if (!account) throw new Error("Connect your wallet first.");
    if (wrongNetwork) throw new Error(`Switch to ${cfg.chainName} first.`);
    const data = encodeFunctionData({ abi, functionName, args });
    setTx({ title: labels.waiting || "Waiting for wallet", message: "Review the transaction in your wallet." });
    const gasFees = await getGasFees();
    const hash = await request("eth_sendTransaction", [
      { from: account, to: cfg.contractAddress, data, value: toHexValue(value), ...gasFees },
    ]);
    setTx({ title: labels.submitted || "Transaction submitted", message: `${shortAddress(hash)} is confirming.` });
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

  async function handleAction(fn, successTitle, successMessage) {
    try {
      await fn();
      setTx({ title: successTitle, message: successMessage, type: "success" });
    } catch (error) {
      setTx({ title: "Action failed", message: readableError(error), type: "error" });
    }
  }

  useEffect(() => {
    if (!hasWallet) return undefined;
    window.ethereum.request({ method: "eth_accounts" }).then(async (accounts) => {
      if (!accounts[0]) return;
      const nextChainId = await request("eth_chainId");
      setAccount(accounts[0]);
      setChainId(nextChainId);
      setVaults(loadVaults(accounts[0], nextChainId));
    });
    const onAccounts = (accounts) => {
      const nextAccount = accounts[0] || "";
      setAccount(nextAccount);
      setUser(null);
      setSelectedId("");
      setVaults(loadVaults(nextAccount, chainId));
      if (!nextAccount) setView("home");
    };
    const onChain = (nextChainId) => {
      setChainId(nextChainId);
      setVaults(loadVaults(account, nextChainId));
    };
    window.ethereum.on?.("accountsChanged", onAccounts);
    window.ethereum.on?.("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
  }, [hasWallet, account, chainId]);

  useEffect(() => {
    if (account) refreshUser(vaults);
  }, [account, chainId]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goHome = () => {
    setView("home");
    setSelectedId("");
    setModal(null);
  };

  return (
    <div className="min-h-screen">
      <Header
        account={account}
        wrongNetwork={wrongNetwork}
        view={view}
        onHome={goHome}
        onConnect={() => handleAction(connectWallet, "Wallet connected", "VaultPay is ready.")}
        onDashboard={() => setView("dashboard")}
        onCreate={() => setModal("create")}
        onSwitch={() => handleAction(switchNetwork, "Network switched", `Connected to ${cfg.chainName}.`)}
      />
      {view === "home" || !account ? (
        <Landing account={account} onConnect={() => handleAction(connectWallet, "Wallet connected", "VaultPay is ready.")} onDashboard={() => setView("dashboard")} />
      ) : (
        <Dashboard
          user={user}
          account={account}
          vaults={activeVaults}
          totalSaved={totalSaved}
          readyCount={readyCount}
          selectedVault={selectedVault}
          onHome={goHome}
          onCreate={() => setModal("create")}
          onView={(id) => setSelectedId(id)}
          onAdd={(id) => { setSelectedId(id); setModal("add"); }}
          onWithdraw={(id) => { setSelectedId(id); setModal("withdraw"); }}
          onJoin={(event) => {
            event.preventDefault();
            const name = new FormData(event.currentTarget).get("userName") || "VaultPay saver";
            handleAction(async () => {
              await sendTx("joinBitsave", [Array.from(encoder.encode(String(name)))], BigInt(cfg.joinFeeWei));
              await refreshUser(vaults);
            }, "Joined VaultPay", "You can now create savings vaults.");
          }}
        />
      )}
      {modal === "create" && (
        <CreateModal
          onClose={() => setModal(null)}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            handleAction(async () => {
              const name = String(data.get("name") || "").trim();
              const amountWei = parseUnits(String(data.get("amount") || "0"), cfg.nativeCurrency.decimals);
              const maturityTime = Math.floor(new Date(data.get("maturity")).getTime() / 1000);
              const penalty = Number(data.get("penalty"));
              const safeMode = data.get("safeMode") === "on";
              if (!name) throw new Error("Saving name is required.");
              if (amountWei <= 0n) throw new Error("Amount must be greater than zero.");
              if (!Number.isFinite(maturityTime) || maturityTime <= Math.floor(Date.now() / 1000)) throw new Error("Maturity date must be in the future.");
              if (!Number.isInteger(penalty) || penalty < 0 || penalty > 100) throw new Error("Penalty must be between 0 and 100%.");
              await sendTx("createSaving", [name, BigInt(maturityTime), penalty, safeMode], amountWei);
              const nextVaults = [
                ...vaults.filter((vault) => vault.name.toLowerCase() !== name.toLowerCase()),
                { id: crypto.randomUUID(), name, amountWei: amountWei.toString(), maturityTime, penalty, safeMode, startTime: Math.floor(Date.now() / 1000) },
              ];
              saveVaults(nextVaults);
              await refreshVaults(nextVaults);
              setModal(null);
            }, "Saving created", "Your vault is now tracked in VaultPay.");
          }}
        />
      )}
      {modal === "add" && selectedVault && (
        <AddFundsModal
          vault={selectedVault}
          onClose={() => setModal(null)}
          onSubmit={(event) => {
            event.preventDefault();
            const amountWei = parseUnits(String(new FormData(event.currentTarget).get("amount") || "0"), cfg.nativeCurrency.decimals);
            handleAction(async () => {
              if (amountWei <= 0n) throw new Error("Amount must be greater than zero.");
              await sendTx("incrementSaving", [selectedVault.name], amountWei);
              const nextVaults = vaults.map((vault) => vault.id === selectedVault.id ? { ...vault, amountWei: (BigInt(vault.amountWei) + amountWei).toString() } : vault);
              saveVaults(nextVaults);
              await refreshVaults(nextVaults);
              setModal(null);
            }, "Funds added", `${formatAmount(amountWei)} added to ${selectedVault.name}.`);
          }}
        />
      )}
      {modal === "withdraw" && selectedVault && (
        <WithdrawModal
          vault={selectedVault}
          onClose={() => setModal(null)}
          onSubmit={(event) => {
            event.preventDefault();
            handleAction(async () => {
              await sendTx("withdrawSavings", [selectedVault.name]);
              saveVaults(vaults.map((vault) => vault.id === selectedVault.id ? { ...vault, withdrawn: true } : vault));
              setSelectedId("");
              setModal(null);
            }, "Withdrawal complete", `${selectedVault.name} has been marked withdrawn.`);
          }}
        />
      )}
      {tx && <Toast tx={tx} onClose={() => setTx(null)} />}
    </div>
  );
}

function Header({ account, wrongNetwork, view, onHome, onConnect, onDashboard, onCreate, onSwitch }) {
  return (
    <header className="mx-auto flex w-[min(1120px,calc(100%-32px))] items-center justify-between gap-4 py-5 max-sm:flex-col max-sm:items-start">
      <button onClick={onHome} className="flex min-w-0 items-center gap-3 rounded-xl bg-transparent p-1 text-left text-vault-ink focus:outline-3 focus:outline-vault-blue/25" aria-label="Go to VaultPay home">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-vault-blue font-extrabold text-white">V</span>
        <span>
          <span className="block text-lg font-extrabold">VaultPay</span>
          <span className="block text-sm text-vault-muted">Save like PayPal. Settle on Arbitrum.</span>
        </span>
      </button>
      <div className="flex flex-wrap items-center justify-end gap-2 max-sm:justify-start">
        {account && <span className="rounded-full border border-vault-line bg-white px-3 py-2 text-sm"><span className={cx("mr-2 inline-block h-2 w-2 rounded-full", wrongNetwork ? "bg-vault-warning" : "bg-vault-success")} />{wrongNetwork ? "Wrong network" : cfg.chainName}</span>}
        {account && <span className="rounded-full border border-vault-line bg-white px-3 py-2 text-sm">{shortAddress(account)}</span>}
        {wrongNetwork && <Button kind="secondary" onClick={onSwitch}>Switch Network</Button>}
        {account ? <Button onClick={view === "home" ? onDashboard : onCreate}>{view === "home" ? "Dashboard" : "Create Saving"}</Button> : <Button onClick={onConnect}>Connect Wallet</Button>}
      </div>
    </header>
  );
}

function Landing({ account, onConnect, onDashboard }) {
  return (
    <main className="mx-auto grid w-[min(1120px,calc(100%-32px))] grid-cols-[minmax(0,1fr)_390px] items-center gap-11 py-12 max-lg:grid-cols-1 max-sm:py-6">
      <section>
        <p className="text-vault-muted">Built with Arbitrum Stylus + Rust</p>
        <h1 className="m-0 max-w-3xl text-[clamp(2.4rem,7vw,5.5rem)] font-extrabold leading-none tracking-normal">PayPal-style savings, powered by Arbitrum.</h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-vault-muted">Create simple crypto savings vaults, add funds over time, and withdraw through transparent onchain rules.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Button onClick={account ? onDashboard : onConnect}>{account ? "Open Dashboard" : "Connect Wallet"}</Button>
          <Button kind="secondary" onClick={onDashboard}>View Demo Flow</Button>
        </div>
      </section>
      <aside className="rounded-lg border border-vault-line bg-white p-6 shadow-[0_16px_42px_rgba(31,45,61,0.08)]">
        <Badge kind="success">Simple savings. Onchain discipline.</Badge>
        <p className="mt-5 text-vault-muted">Total Saved</p>
        <p className="my-3 text-4xl font-extrabold">2.40 {cfg.nativeCurrency.symbol}</p>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Active Vaults" value="3" />
          <Metric label="Ready" value="1" />
        </div>
      </aside>
    </main>
  );
}

function Dashboard({ user, vaults, totalSaved, readyCount, selectedVault, onHome, onCreate, onView, onAdd, onWithdraw, onJoin }) {
  return (
    <main className="mx-auto w-[min(1120px,calc(100%-32px))] pb-16 pt-4">
      <button onClick={onHome} className="mb-3 inline-flex min-h-10 items-center gap-2 bg-transparent font-bold text-vault-blue">&larr; Home</button>
      {!user && <JoinCard onJoin={onJoin} />}
      <div className="my-5 flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start">
        <div><p className="text-vault-muted">Dashboard</p><h2 className="m-0 text-2xl font-extrabold">Your savings</h2></div>
        <Button onClick={onCreate}>Create Saving</Button>
      </div>
      <section className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
        <Summary label="Total Saved" value={formatAmount(totalSaved)} />
        <Summary label="Active Vaults" value={vaults.length} />
        <Summary label="Matured / Ready" value={readyCount} />
      </section>
      <h2 className="mb-4 mt-7 text-2xl font-extrabold">Vaults</h2>
      {vaults.length ? <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">{vaults.map((vault) => <VaultCard key={vault.id} vault={vault} onView={onView} onAdd={onAdd} />)}</div> : <EmptyState onCreate={onCreate} />}
      {selectedVault && <Details vault={selectedVault} onBack={() => onView("")} onAdd={onAdd} onWithdraw={onWithdraw} />}
    </main>
  );
}

function JoinCard({ onJoin }) {
  return (
    <section className="mb-5 rounded-lg border border-vault-line bg-white p-7 shadow-[0_10px_28px_rgba(31,45,61,0.05)]">
      <h2 className="mb-2 text-2xl font-extrabold">Join VaultPay</h2>
      <p className="mb-5 text-vault-muted">Join once to start creating onchain savings vaults.</p>
      <form onSubmit={onJoin} className="grid gap-4">
        <label className="grid gap-2 text-sm font-semibold text-vault-muted">Your display name<input name="userName" required placeholder="Ada" className="min-h-12 rounded-lg border border-vault-line px-3 text-vault-ink" /></label>
        <div className="grid gap-2 rounded-lg border border-vault-line bg-slate-50 p-4"><Line label="Joining fee" value={`${cfg.joinFeeWei} wei`} /><Line label="Contract" value={shortAddress(cfg.contractAddress)} /></div>
        <Button type="submit">Join VaultPay</Button>
      </form>
    </section>
  );
}

function VaultCard({ vault, onView, onAdd }) {
  const status = statusFor(vault);
  return (
    <article className="rounded-lg border border-vault-line bg-white p-5 shadow-[0_10px_28px_rgba(31,45,61,0.05)]">
      <div className="flex items-start justify-between gap-3"><h3 className="m-0 text-lg font-extrabold">{vault.name}</h3><Badge kind={status.kind}>{status.label}</Badge></div>
      <p className="my-5 text-3xl font-extrabold">{formatAmount(vault.amountWei)}</p>
      <div className="mb-5 grid gap-2"><Line label="Safe mode" value={vault.safeMode ? "On" : "Off"} /><Line label="Matures on" value={formatDate(vault.maturityTime)} /><Line label="Penalty" value={`${vault.penalty}%`} /></div>
      <div className="flex gap-3"><Button kind="secondary" onClick={() => onView(vault.id)}>View</Button><Button kind="ghost" onClick={() => onAdd(vault.id)}>Add Funds</Button></div>
    </article>
  );
}

function Details({ vault, onBack, onAdd, onWithdraw }) {
  const status = statusFor(vault);
  const matured = status.kind === "success";
  return (
    <section className="mt-5 rounded-lg border border-vault-line bg-white p-7 shadow-[0_10px_28px_rgba(31,45,61,0.05)]">
      <button onClick={onBack} className="mb-3 bg-transparent font-bold text-vault-blue">&larr; Dashboard</button>
      <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start"><div><h2 className="m-0 text-2xl font-extrabold">{vault.name}</h2><p className="text-vault-muted">Your savings are tracked onchain.</p></div><Badge kind={status.kind}>{matured ? "Matured" : "Early withdrawal penalty applies"}</Badge></div>
      <div className="mt-5 grid grid-cols-[1.1fr_.9fr] gap-4 max-lg:grid-cols-1">
        <div className="rounded-lg border border-vault-line bg-slate-50 p-5"><p className="text-vault-muted">Amount saved</p><p className="my-4 text-4xl font-extrabold">{formatAmount(vault.amountWei)}</p><div className="flex gap-3"><Button onClick={() => onWithdraw(vault.id)}>{matured ? "Withdraw" : "Withdraw Early"}</Button><Button kind="secondary" onClick={() => onAdd(vault.id)}>Add Funds</Button></div></div>
        <div className="grid gap-3 rounded-lg border border-vault-line bg-slate-50 p-5"><Line label="Safe mode" value={vault.safeMode ? "On" : "Off"} /><Line label="Start date" value={formatDate(vault.startTime)} /><Line label="Maturity date" value={formatDate(vault.maturityTime)} /><Line label="Penalty percentage" value={`${vault.penalty}%`} /></div>
      </div>
    </section>
  );
}

function CreateModal(props) {
  const minDate = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);
  return <Modal title="Create Saving" {...props}><label className="grid gap-2 text-sm font-semibold text-vault-muted">Saving name<input name="name" required placeholder="Emergency Fund" className="field" /></label><div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1"><label className="grid gap-2 text-sm font-semibold text-vault-muted">Amount<input name="amount" required placeholder="0.05" className="field" /></label><label className="grid gap-2 text-sm font-semibold text-vault-muted">Penalty percentage<input name="penalty" type="number" min="0" max="100" defaultValue="5" required className="field" /></label></div><label className="grid gap-2 text-sm font-semibold text-vault-muted">Maturity date and time<input name="maturity" type="datetime-local" min={minDate} required className="field" /></label><label className="flex items-center justify-between gap-4 rounded-lg border border-vault-line bg-slate-50 p-4"><span><strong>Safe mode</strong><span className="text-vault-muted"> Keep this saving protected until maturity.</span></span><input name="safeMode" type="checkbox" defaultChecked /></label><Button type="submit">Create Saving</Button></Modal>;
}

function AddFundsModal({ vault, ...props }) {
  return <Modal title="Add Funds" {...props}><div className="grid gap-2 rounded-lg border border-vault-line bg-slate-50 p-4"><Line label="Selected saving" value={vault.name} /><Line label="Current amount" value={formatAmount(vault.amountWei)} /></div><label className="grid gap-2 text-sm font-semibold text-vault-muted">Amount to add<input name="amount" required placeholder="0.02" className="field" /></label><Button type="submit">Add Funds</Button></Modal>;
}

function WithdrawModal({ vault, ...props }) {
  const matured = statusFor(vault).kind === "success";
  return <Modal title={matured ? "Withdraw" : "Withdraw Early"} {...props}><div className="grid gap-2 rounded-lg border border-vault-line bg-slate-50 p-4"><Line label="Saving" value={vault.name} /><Line label="Amount" value={formatAmount(vault.amountWei)} /><Line label="Maturity" value={formatDate(vault.maturityTime)} /></div>{matured ? <p className="text-vault-muted">This saving has reached maturity and is ready to withdraw.</p> : <div className="rounded-lg bg-amber-50 p-4 text-vault-warning">This saving has not reached maturity. Withdrawing now may apply a penalty of {vault.penalty}%.</div>}{!matured && <label className="flex items-center justify-between gap-4 rounded-lg border border-vault-line bg-slate-50 p-4"><span>I understand the early withdrawal penalty may apply.</span><input type="checkbox" required /></label>}<Button kind={matured ? "primary" : "danger"} type="submit">{matured ? "Withdraw" : "Withdraw Early"}</Button></Modal>;
}

function Modal({ title, children, onClose, onSubmit }) {
  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-slate-900/45 p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="max-h-[calc(100vh-36px)] w-[min(560px,100%)] overflow-auto rounded-lg bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mb-5 flex items-center justify-between gap-4"><div className="flex items-center gap-3"><button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full bg-slate-100">&larr;</button><h2 className="m-0 text-2xl font-extrabold">{title}</h2></div><button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full bg-slate-100" aria-label="Close">x</button></div>
        <form onSubmit={onSubmit} className="grid gap-4">{children}</form>
      </section>
    </div>
  );
}

function Toast({ tx, onClose }) {
  return <aside className="fixed bottom-5 right-5 z-30 flex w-[min(420px,calc(100%-40px))] items-start justify-between gap-4 rounded-lg border border-vault-line bg-white p-4 shadow-xl"><div><strong className={cx("block", tx.type === "error" && "text-vault-danger")}>{tx.title}</strong><span className="text-vault-muted">{tx.message}</span></div><button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full bg-slate-100">x</button></aside>;
}

function EmptyState({ onCreate }) {
  return <div className="grid min-h-72 place-items-center rounded-lg border border-vault-line bg-white p-7 text-center shadow-[0_10px_28px_rgba(31,45,61,0.05)]"><div><Badge>New saver</Badge><h3 className="mt-4 text-xl font-extrabold">No savings yet</h3><p className="mx-auto mb-5 max-w-md text-vault-muted">Create your first savings vault and start building onchain discipline.</p><Button onClick={onCreate}>Create Saving</Button></div></div>;
}

function Button({ kind = "primary", className = "", ...props }) {
  const styles = { primary: "bg-vault-blue text-white hover:bg-vault-blue-dark", secondary: "border border-vault-line bg-white text-vault-ink", ghost: "bg-transparent text-vault-blue", danger: "bg-vault-danger text-white" };
  return <button className={cx("inline-flex min-h-11 items-center justify-center rounded-full px-5 font-bold focus:outline-3 focus:outline-vault-blue/25", styles[kind], className)} {...props} />;
}

function Badge({ kind = "neutral", children }) {
  const styles = { neutral: "bg-blue-50 text-vault-blue", success: "bg-emerald-50 text-vault-success", warning: "bg-amber-50 text-vault-warning" };
  return <span className={cx("inline-flex min-h-7 items-center rounded-full px-3 text-xs font-extrabold", styles[kind])}>{children}</span>;
}

function Metric({ label, value }) { return <div className="rounded-lg border border-vault-line bg-slate-50 p-4"><span className="text-vault-muted">{label}</span><strong className="mt-2 block text-xl">{value}</strong></div>; }
function Summary({ label, value }) { return <div className="rounded-lg border border-vault-line bg-white p-5 shadow-[0_10px_28px_rgba(31,45,61,0.05)]"><span className="text-vault-muted">{label}</span><strong className="mt-2 block text-3xl">{value}</strong></div>; }
function Line({ label, value }) { return <div className="flex justify-between gap-3 text-vault-muted"><span>{label}</span><strong className="text-right text-vault-ink">{value}</strong></div>; }

export default App;
