import { ethers } from "https://esm.sh/ethers@6.13.4";
import { fetchAndLoadSolc } from "https://esm.sh/web-solc@0.1.8";

const CHAIN_ID = 137n;
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

const ORACLE_ABI = [
  "function reporter() view returns (address)",
  "function owner() view returns (address)",
  "function crcReserveE6() view returns (uint256)",
  "function crcPerUsdE6() view returns (uint256)",
  "function updatedAt() view returns (uint256)",
  "function updateReserve(uint256,uint256)"
];

const TOKEN_ABI = [
  "function admin() view returns (address)",
  "function payoutOperator() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function mintCapacityE6() view returns (uint256)",
  "function fullyBacked() view returns (bool)",
  "function reserveBreakdown() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function mint(address,uint256) returns (bool)",
  "function redeemUSDC(uint256) returns (bool)",
  "function requestCrcRedemption(uint256) returns (uint256)",
  "function completeCrcRedemption(uint256)",
  "function cancelCrcRedemption(uint256)"
];

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)"
];

let provider, signer, account;
let oracleCompiled, tokenCompiled;

let oracleAddress = localStorage.getItem("dzc_oracle") || "";
let tokenAddress = localStorage.getItem("dzc_token") || "";

const $ = id => document.getElementById(id);
const setStatus = msg => $("status").textContent = msg;
const short = a => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—";
const fmt6 = x => Number(ethers.formatUnits(x,6)).toLocaleString("en-US",{maximumFractionDigits:6});
const fmtCRC = x => Number(ethers.formatUnits(x,6)).toLocaleString("es-CR",{maximumFractionDigits:2});

async function ensurePolygon(){
  const n = await provider.getNetwork();
  if(n.chainId === CHAIN_ID) return;

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
  $("network").textContent = "Polygon · 137";
  $("reporterWallet").value ||= account;
  $("payoutWallet").value ||= account;
  $("mintTo").value ||= account;

  const pol = await provider.getBalance(account);
  $("pol").textContent = `${Number(ethers.formatEther(pol)).toLocaleString("en-US",{maximumFractionDigits:6})} POL`;

  $("compile").disabled = false;
  setStatus("MetaMask conectado.");

  await refresh();
}

async function compileSource(path, contractName){
  const r = await fetch(path,{cache:"no-store"});
  if(!r.ok) throw new Error(`No se pudo leer ${path}`);

  const source = await r.text();
  const filename = path.split("/").pop();

  const solc = await fetchAndLoadSolc("0.8.24");

  try{
    const output = await solc.compile({
      language:"Solidity",
      sources:{[filename]:{content:source}},
      settings:{
        optimizer:{enabled:true,runs:200},
        outputSelection:{"*":{"*":["abi","evm.bytecode.object"]}}
      }
    });

    const errors = (output.errors || []).filter(e => e.severity === "error");
    if(errors.length) throw new Error(errors.map(e=>e.formattedMessage).join("\n"));

    const c = output.contracts[filename][contractName];

    return {
      abi:c.abi,
      bytecode:"0x"+c.evm.bytecode.object
    };
  } finally {
    if(solc?.stopWorker) solc.stopWorker();
  }
}

async function compileAll(){
  setStatus("Compilando Oracle y DZC con Solidity 0.8.24...");

  oracleCompiled = await compileSource("./contracts/CrcReserveOracle.sol","CrcReserveOracle");
  tokenCompiled = await compileSource("./contracts/DoctorZetBackedCoin.sol","DoctorZetBackedCoin");

  $("deployOracle").disabled = false;
  $("deployToken").disabled = !oracleAddress;

  setStatus("Contratos compilados. Revisa las wallets antes de desplegar.");
}

async function deployOracle(){
  if(!signer) await connect();
  if(!oracleCompiled) await compileAll();

  const reporter = $("reporterWallet").value.trim();
  if(!ethers.isAddress(reporter)) throw new Error("Wallet reportera inválida.");

  const factory = new ethers.ContractFactory(
    oracleCompiled.abi,
    oracleCompiled.bytecode,
    signer
  );

  setStatus("MetaMask abrirá la firma para desplegar CrcReserveOracle...");
  const c = await factory.deploy(reporter);
  const tx = c.deploymentTransaction();

  setStatus(`Oracle enviado:\n${tx.hash}\nEsperando confirmación...`);
  await c.waitForDeployment();

  oracleAddress = await c.getAddress();
  localStorage.setItem("dzc_oracle",oracleAddress);

  $("oracleAddress").textContent = oracleAddress;
  $("deployToken").disabled = false;

  setStatus(`Oracle desplegado:\n${oracleAddress}`);
  await refresh();
}

async function deployToken(){
  if(!signer) await connect();
  if(!tokenCompiled) await compileAll();
  if(!ethers.isAddress(oracleAddress)) throw new Error("Primero despliega el Oracle.");

  const payout = $("payoutWallet").value.trim();
  if(!ethers.isAddress(payout)) throw new Error("Wallet operadora de pagos inválida.");

  const factory = new ethers.ContractFactory(
    tokenCompiled.abi,
    tokenCompiled.bytecode,
    signer
  );

  setStatus("MetaMask abrirá la firma para desplegar DoctorZet Backed Coin...");
  const c = await factory.deploy(oracleAddress,payout);
  const tx = c.deploymentTransaction();

  setStatus(`DZC enviado:\n${tx.hash}\nEsperando confirmación...`);
  await c.waitForDeployment();

  tokenAddress = await c.getAddress();
  localStorage.setItem("dzc_token",tokenAddress);

  $("tokenAddress").textContent = tokenAddress;

  setStatus(`DZC desplegado:\n${tokenAddress}`);
  await refresh();
}

function checksOk(){
  return $("checkBalance").checked &&
         $("checkPending").checked &&
         $("checkRate").checked;
}

async function publishReserve(){
  if(!signer) await connect();
  if(!ethers.isAddress(oracleAddress)) throw new Error("Oracle no desplegado.");
  if(!checksOk()) throw new Error("Completa las tres verificaciones.");

  const reserve = $("crcReserve").value.trim();
  const rate = $("crcRate").value.trim();

  if(!reserve || Number(reserve) < 0) throw new Error("Reserva CRC inválida.");
  if(!rate || Number(rate) <= 0) throw new Error("Tipo de cambio inválido.");

  const c = new ethers.Contract(oracleAddress,ORACLE_ABI,signer);

  const reporter = await c.reporter();
  if(reporter.toLowerCase() !== account.toLowerCase()){
    throw new Error("La wallet conectada no es la reportera autorizada.");
  }

  const reserveE6 = ethers.parseUnits(reserve,6);
  const rateE6 = ethers.parseUnits(rate,6);

  setStatus("MetaMask abrirá la firma de actualización de reserva CRC...");
  const tx = await c.updateReserve(reserveE6,rateE6);

  setStatus(`Reserva enviada:\n${tx.hash}`);
  await tx.wait();

  setStatus(`Reserva CRC publicada.\nTx: ${tx.hash}`);
  await refresh();
}

async function depositUsdc(){
  if(!signer) await connect();
  if(!ethers.isAddress(tokenAddress)) throw new Error("DZC no desplegado.");

  const amount = $("usdcDeposit").value.trim();
  if(!amount || Number(amount) <= 0) throw new Error("Cantidad USDC inválida.");

  const usdc = new ethers.Contract(USDC,USDC_ABI,signer);
  const units = ethers.parseUnits(amount,6);

  setStatus(`MetaMask abrirá una transferencia de ${amount} USDC al contrato DZC...`);
  const tx = await usdc.transfer(tokenAddress,units);

  setStatus(`USDC enviado:\n${tx.hash}`);
  await tx.wait();

  setStatus("Reserva USDC depositada.");
  await refresh();
}

async function mintAmount(amount){
  if(!signer) await connect();
  if(!ethers.isAddress(tokenAddress)) throw new Error("DZC no desplegado.");

  const to = $("mintTo").value.trim();
  if(!ethers.isAddress(to)) throw new Error("Wallet receptora inválida.");
  if(!amount || Number(amount) <= 0) throw new Error("Cantidad DZC inválida.");

  const c = new ethers.Contract(tokenAddress,TOKEN_ABI,signer);
  const admin = await c.admin();

  if(admin.toLowerCase() !== account.toLowerCase()){
    throw new Error("La wallet conectada no es el administrador DZC.");
  }

  const units = ethers.parseUnits(String(amount),6);

  setStatus(`MetaMask abrirá la emisión de ${Number(amount).toLocaleString("en-US")} DZC...`);
  const tx = await c.mint(to,units);

  setStatus(`Mint enviado:\n${tx.hash}`);
  await tx.wait();

  setStatus(`${Number(amount).toLocaleString("en-US")} DZC creados dentro de la capacidad respaldada.`);
  await refresh();
}

async function redeemUsdc(){
  if(!signer) await connect();

  const amount = $("redeemUsdcAmount").value.trim();
  if(!amount || Number(amount) <= 0) throw new Error("Cantidad inválida.");

  const c = new ethers.Contract(tokenAddress,TOKEN_ABI,signer);
  const tx = await c.redeemUSDC(ethers.parseUnits(amount,6));

  setStatus(`Redención USDC enviada:\n${tx.hash}`);
  await tx.wait();

  setStatus("Redención USDC confirmada.");
  await refresh();
}

async function requestCrc(){
  if(!signer) await connect();

  const amount = $("redeemCrcAmount").value.trim();
  if(!amount || Number(amount) <= 0) throw new Error("Cantidad inválida.");

  const c = new ethers.Contract(tokenAddress,TOKEN_ABI,signer);
  const tx = await c.requestCrcRedemption(ethers.parseUnits(amount,6));

  setStatus(`Solicitud CRC enviada:\n${tx.hash}`);
  const receipt = await tx.wait();

  setStatus(`Solicitud CRC confirmada.\nTx: ${receipt.hash}\nGuarda el ID de solicitud emitido en el evento CrcRedemptionRequested.`);
  await refresh();
}

async function finalizeCrc(complete){
  if(!signer) await connect();

  const id = $("requestId").value.trim();
  if(!id || Number(id) < 1) throw new Error("ID de solicitud inválido.");

  const c = new ethers.Contract(tokenAddress,TOKEN_ABI,signer);
  const operator = await c.payoutOperator();

  if(operator.toLowerCase() !== account.toLowerCase()){
    throw new Error("La wallet conectada no es la operadora de pagos CRC.");
  }

  const tx = complete
    ? await c.completeCrcRedemption(id)
    : await c.cancelCrcRedemption(id);

  setStatus(`${complete ? "Confirmación" : "Cancelación"} enviada:\n${tx.hash}`);
  await tx.wait();

  setStatus(complete
    ? "Pago CRC marcado como completado y DZC quemado. Actualiza el Oracle con el nuevo saldo BAC antes de emitir más DZC."
    : "Solicitud CRC cancelada y DZC devuelto.");
  await refresh();
}

async function addToken(){
  if(!ethers.isAddress(tokenAddress)) throw new Error("DZC no desplegado.");

  await window.ethereum.request({
    method:"wallet_watchAsset",
    params:{
      type:"ERC20",
      options:{
        address:tokenAddress,
        symbol:"DZC",
        decimals:6
      }
    }
  });
}

async function refresh(){
  $("oracleAddress").textContent = oracleAddress || "Pendiente";
  $("tokenAddress").textContent = tokenAddress || "Pendiente";

  if(!provider || !account) return;

  if(ethers.isAddress(oracleAddress)){
    const o = new ethers.Contract(oracleAddress,ORACLE_ABI,provider);
    const reporter = await o.reporter();

    $("publishReserve").disabled =
      reporter.toLowerCase() !== account.toLowerCase();
  }

  if(!ethers.isAddress(tokenAddress)) return;

  const c = new ethers.Contract(tokenAddress,TOKEN_ABI,provider);

  const [
    admin,
    payout,
    supply,
    capacity,
    backed,
    breakdown
  ] = await Promise.all([
    c.admin(),
    c.payoutOperator(),
    c.totalSupply(),
    c.mintCapacityE6(),
    c.fullyBacked(),
    c.reserveBreakdown()
  ]);

  const [
    usdc,
    rawCrc,
    adjustedCrc,
    crcRate,
    crcUsd,
    totalUsd,
    oracleUpdated
  ] = breakdown;

  $("admin").textContent = short(admin);
  $("supply").textContent = `${fmt6(supply)} DZC`;
  $("usdcReserve").textContent = `${fmt6(usdc)} USDC`;
  $("rawCrc").textContent = `₡${fmtCRC(rawCrc)}`;
  $("adjustedCrc").textContent = `₡${fmtCRC(adjustedCrc)}`;
  $("crcUsd").textContent = `US$${fmt6(crcUsd)}`;
  $("totalReserve").textContent = `US$${fmt6(totalUsd)}`;
  $("mintCapacity").textContent = `${fmt6(capacity)} DZC`;
  $("backed").textContent = backed ? "Sí" : "No";
  $("oracleTime").textContent = new Date(Number(oracleUpdated)*1000).toLocaleString("es-CR");

  const isAdmin = admin.toLowerCase() === account.toLowerCase();
  const isPayout = payout.toLowerCase() === account.toLowerCase();

  for(const id of ["mintCustom","mint1m","mint10m","mint100m"]){
    $(id).disabled = !isAdmin;
  }

  $("depositUsdc").disabled = false;
  $("redeemUsdc").disabled = false;
  $("requestCrc").disabled = false;
  $("addToken").disabled = false;
  $("refresh").disabled = false;
  $("completeCrc").disabled = !isPayout;
  $("cancelCrc").disabled = !isPayout;
}

function exportAttestation(){
  const payload = {
    system:"DoctorZet Backed Coin",
    bank:"BAC San José",
    reserve_account_display:"CR76 **** **** **** **** 2530",
    oracle:oracleAddress || null,
    token:tokenAddress || null,
    reporter_wallet:account || null,
    verified_crc_reserve:$("crcReserve").value || null,
    verified_crc_per_usd:$("crcRate").value || null,
    internal_reference:$("reference").value.trim() || null,
    checks:{
      balance_reviewed:$("checkBalance").checked,
      pending_debits_reviewed:$("checkPending").checked,
      fx_rate_reviewed:$("checkRate").checked
    },
    generated_at:new Date().toISOString()
  };

  const blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = `doctorzet-reserve-attestation-${Date.now()}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

function bind(id,fn){
  $(id).addEventListener("click",()=>fn().catch(e=>{
    setStatus(e.shortMessage || e.reason || e.message || String(e));
  }));
}

bind("connect",connect);
bind("compile",compileAll);
bind("deployOracle",deployOracle);
bind("deployToken",deployToken);
bind("publishReserve",publishReserve);
bind("depositUsdc",depositUsdc);
bind("refresh",refresh);
bind("mintCustom",()=>mintAmount($("mintAmount").value));
bind("mint1m",()=>mintAmount("1000000"));
bind("mint10m",()=>mintAmount("10000000"));
bind("mint100m",()=>mintAmount("100000000"));
bind("redeemUsdc",redeemUsdc);
bind("requestCrc",requestCrc);
bind("completeCrc",()=>finalizeCrc(true));
bind("cancelCrc",()=>finalizeCrc(false));
bind("addToken",addToken);

$("exportAttestation").addEventListener("click",exportAttestation);

$("oracleAddress").textContent = oracleAddress || "Pendiente";
$("tokenAddress").textContent = tokenAddress || "Pendiente";
