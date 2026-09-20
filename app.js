import { ethers } from "https://esm.sh/ethers@6.13.4";
import { fetchAndLoadSolc } from "https://esm.sh/web-solc@0.1.8";

const CHAIN_ID = 137n;
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)"
];
const DZUSD_READ_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function reserveUSDC() view returns (uint256)",
  "function fullyBacked() view returns (bool)",
  "function deposit(uint256 amount) returns (bool)",
  "function redeem(uint256 amount) returns (bool)"
];

let provider, signer, account;
let compiledABI, compiledBytecode;
let deployedAddress = localStorage.getItem("dzusd_contract") || "";
let crcRate = null;

const $ = (id) => document.getElementById(id);
const status = (msg) => $("status").textContent = msg;
const short = (a) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—";

async function getSource(){
  const r = await fetch("./DoctorZetUSD.sol", {cache:"no-store"});
  if(!r.ok) throw new Error("No se pudo leer DoctorZetUSD.sol");
  return await r.text();
}

async function loadCRC(){
  try{
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await r.json();
    crcRate = Number(data?.rates?.CRC || 0) || null;
    $("rate").textContent = crcRate
      ? `US$1 ≈ ₡${crcRate.toLocaleString("es-CR",{maximumFractionDigits:2})}`
      : "No disponible";
  }catch{
    $("rate").textContent = "No disponible";
  }
}

async function ensurePolygon(){
  const network = await provider.getNetwork();
  if(network.chainId === CHAIN_ID) return;

  try{
    await window.ethereum.request({
      method:"wallet_switchEthereumChain",
      params:[{chainId:"0x89"}]
    });
  }catch(e){
    if(e.code !== 4902) throw e;
    await window.ethereum.request({
      method:"wallet_addEthereumChain",
      params:[{
        chainId:"0x89",
        chainName:"Polygon Mainnet",
        nativeCurrency:{name:"POL",symbol:"POL",decimals:18},
        rpcUrls:["https://polygon.drpc.org"],
        blockExplorerUrls:["https://polygonscan.com"]
      }]
    });
  }
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
}

async function connect(){
  if(!window.ethereum) throw new Error("MetaMask no está instalado.");
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts",[]);
  await ensurePolygon();
  signer = await provider.getSigner();
  account = await signer.getAddress();

  $("wallet").textContent = short(account);
  $("network").textContent = "Polygon PoS · 137";
  $("networkDot").classList.add("ok");
  $("deploy").disabled = false;

  const bal = await provider.getBalance(account);
  $("pol").textContent = `${Number(ethers.formatEther(bal)).toLocaleString("en-US",{maximumFractionDigits:6})} POL`;
  status("MetaMask conectado. La firma del despliegue se hará dentro de MetaMask.");
  if(deployedAddress) await refreshContract();
}

async function compileContract(){
  status("Compilando DoctorZetUSD.sol con Solidity 0.8.24 en tu navegador…");
  $("compile").disabled = true;
  try{
    const source = await getSource();
    const solc = await fetchAndLoadSolc("0.8.24");
    try{
      const output = await solc.compile({
        language:"Solidity",
        sources:{"DoctorZetUSD.sol":{content:source}},
        settings:{
          optimizer:{enabled:true,runs:200},
          outputSelection:{"*":{"*":["abi","evm.bytecode.object"]}}
        }
      });

      const errors = (output.errors || []).filter(e => e.severity === "error");
      if(errors.length) throw new Error(errors.map(e=>e.formattedMessage).join("\n"));

      const c = output.contracts["DoctorZetUSD.sol"]["DoctorZetUSD"];
      compiledABI = c.abi;
      compiledBytecode = "0x" + c.evm.bytecode.object;
      $("compileState").textContent = "Compilado";
      $("compileDot").classList.add("ok");
      status("Contrato compilado. Ya puedes revisar el gas y desplegar.");
    } finally {
      if(solc?.stopWorker) solc.stopWorker();
    }
  } finally {
    $("compile").disabled = false;
  }
}

async function estimateDeploy(){
  if(!signer) await connect();
  if(!compiledBytecode) await compileContract();

  const factory = new ethers.ContractFactory(compiledABI, compiledBytecode, signer);
  const txReq = await factory.getDeployTransaction();
  const gas = await signer.estimateGas(txReq);
  const fees = await provider.getFeeData();
  const gasPrice = fees.maxFeePerGas || fees.gasPrice || 0n;
  const est = gas * gasPrice;

  $("gas").textContent = `≈ ${Number(ethers.formatEther(est)).toLocaleString("en-US",{maximumFractionDigits:8})} POL`;
  return {factory,gas,gasPrice};
}

async function deploy(){
  if(!$("confirm").checked) throw new Error("Confirma que entiendes que MetaMask solicitará una firma y cobrará gas en POL.");
  if(!signer) await connect();
  await ensurePolygon();
  if(!compiledBytecode) await compileContract();

  const {factory} = await estimateDeploy();

  $("deploy").disabled = true;
  try{
    status("Abriendo MetaMask para firmar el despliegue…");
    const contract = await factory.deploy();
    const tx = contract.deploymentTransaction();
    $("txHash").textContent = tx.hash;
    $("txLink").href = `https://polygonscan.com/tx/${tx.hash}`;
    $("txLink").hidden = false;

    status(`Transacción enviada.\n${tx.hash}\nEsperando confirmación en Polygon…`);
    await contract.waitForDeployment();

    deployedAddress = await contract.getAddress();
    localStorage.setItem("dzusd_contract", deployedAddress);
    $("contractAddress").textContent = deployedAddress;
    $("contractLink").href = `https://polygonscan.com/address/${deployedAddress}`;
    $("contractLink").hidden = false;
    $("addToken").disabled = false;
    $("refresh").disabled = false;
    $("depositBtn").disabled = false;
    $("redeemBtn").disabled = false;

    status(`DZUSD desplegado en Polygon.\nContrato: ${deployedAddress}`);
    await refreshContract();
  } finally {
    $("deploy").disabled = false;
  }
}

async function refreshContract(){
  if(!provider || !deployedAddress || !account) return;
  const c = new ethers.Contract(deployedAddress, DZUSD_READ_ABI, provider);
  const [supply,reserve,backed,userBal] = await Promise.all([
    c.totalSupply(), c.reserveUSDC(), c.fullyBacked(), c.balanceOf(account)
  ]);

  const supplyN = Number(ethers.formatUnits(supply,6));
  const reserveN = Number(ethers.formatUnits(reserve,6));
  const balN = Number(ethers.formatUnits(userBal,6));

  $("supply").textContent = `${supplyN.toLocaleString("en-US",{maximumFractionDigits:6})} DZUSD`;
  $("reserve").textContent = `${reserveN.toLocaleString("en-US",{maximumFractionDigits:6})} USDC`;
  $("backed").textContent = backed ? "Sí · 100%+" : "No";
  $("backed").style.color = backed ? "var(--good)" : "var(--red)";
  $("dzbal").textContent = `${balN.toLocaleString("en-US",{maximumFractionDigits:6})} DZUSD`;
  $("crc").textContent = crcRate
    ? `≈ ₡${(balN*crcRate).toLocaleString("es-CR",{maximumFractionDigits:2})}`
    : "CRC no disponible";
}

async function addToken(){
  if(!deployedAddress) throw new Error("Primero despliega el contrato.");
  await window.ethereum.request({
    method:"wallet_watchAsset",
    params:{
      type:"ERC20",
      options:{
        address:deployedAddress,
        symbol:"DZUSD",
        decimals:6,
        image:new URL("./dzusd-logo.svg", location.href).href
      }
    }
  });
}

async function deposit(){
  if(!signer) await connect();
  if(!deployedAddress) throw new Error("Primero despliega el contrato.");
  const amount = $("depositAmount").value.trim();
  if(!amount || Number(amount)<=0) throw new Error("Ingresa una cantidad válida de USDC.");

  const units = ethers.parseUnits(amount,6);
  const usdc = new ethers.Contract(USDC, USDC_ABI, signer);
  const dz = new ethers.Contract(deployedAddress, DZUSD_READ_ABI, signer);
  const current = await usdc.allowance(account,deployedAddress);

  if(current < units){
    status("MetaMask abrirá una aprobación de USDC…");
    const approveTx = await usdc.approve(deployedAddress,units);
    await approveTx.wait();
  }

  status("MetaMask abrirá el depósito de USDC para emitir DZUSD…");
  const tx = await dz.deposit(units);
  status(`Depósito enviado: ${tx.hash}`);
  await tx.wait();
  status("Depósito confirmado. DZUSD emitido 1:1 contra USDC.");
  await refreshContract();
}

async function redeem(){
  if(!signer) await connect();
  if(!deployedAddress) throw new Error("Primero despliega el contrato.");
  const amount = $("redeemAmount").value.trim();
  if(!amount || Number(amount)<=0) throw new Error("Ingresa una cantidad válida de DZUSD.");

  const units = ethers.parseUnits(amount,6);
  const dz = new ethers.Contract(deployedAddress, DZUSD_READ_ABI, signer);
  status("MetaMask abrirá la redención. DZUSD será quemado y recibirás USDC 1:1…");
  const tx = await dz.redeem(units);
  status(`Redención enviada: ${tx.hash}`);
  await tx.wait();
  status("Redención confirmada.");
  await refreshContract();
}

function bind(id,fn){
  $(id).addEventListener("click",()=>fn().catch(e=>status(e.shortMessage || e.reason || e.message || String(e))));
}
bind("connect",connect);
bind("compile",compileContract);
bind("estimate",estimateDeploy);
bind("deploy",deploy);
bind("addToken",addToken);
bind("refresh",refreshContract);
bind("depositBtn",deposit);
bind("redeemBtn",redeem);

$("contractAddress").textContent = deployedAddress || "Pendiente de despliegue";
$("contractLink").hidden = !deployedAddress;
$("addToken").disabled = !deployedAddress;
$("refresh").disabled = !deployedAddress;
$("depositBtn").disabled = !deployedAddress;
$("redeemBtn").disabled = !deployedAddress;
if(deployedAddress) $("contractLink").href = `https://polygonscan.com/address/${deployedAddress}`;
loadCRC();
