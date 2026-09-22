'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { ethers } = require('ethers');
const rogApi = require('./rog-community-manager');

const WALLET_RE = /^0x[a-f0-9]{40}$/;
const HASH_RE = /^0x[a-f0-9]{64}$/;
const DEFAULT_ROG_AMOUNT_USDC = 2;
const ERC20_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const ROG_ABI = [
  'function registerDonation(uint256 amount) external returns (uint256)',
  'event DonationRegistered(uint256 indexed donationId, address indexed donor, uint256 amount, uint256 expireTime)'
];

let provider = null;
function makeError(message, code, retryable = false) { const error = new Error(message); error.code = code; error.retryable = retryable; return error; }
function normalizeWallet(value, label = 'wallet') { const wallet = String(value || '').trim().toLowerCase(); if (!WALLET_RE.test(wallet)) throw makeError(`${label} non valido`, 'ROG_DONATION_WALLET_INVALID'); return wallet; }
function normalizeHash(value, label = 'txHash') { const hash = String(value || '').trim().toLowerCase(); if (!HASH_RE.test(hash)) throw makeError(`${label} non valido`, 'ROG_DONATION_HASH_INVALID'); return hash; }
function readAddress(name) { return normalizeWallet(process.env[name], name); }
function getProvider() { if (!provider) { const rpc = String(process.env.POLYGON_RPC_URL || '').trim(); if (!rpc) throw makeError('POLYGON_RPC_URL non configurata', 'ROG_DONATION_CONFIG_UNAVAILABLE'); provider = new ethers.JsonRpcProvider(rpc); } return provider; }
function getConfig() {
  const amount = Number(process.env.ROG_REQUIRED_DONATION_USDC || DEFAULT_ROG_AMOUNT_USDC);
  if (!Number.isInteger(amount) || amount < 2 || amount % 2 !== 0) throw makeError('ROG_REQUIRED_DONATION_USDC deve essere un intero pari >= 2', 'ROG_DONATION_CONFIG_UNAVAILABLE');
  return { treasuryWallet: readAddress('ROG_TREASURY_WALLET'), contractAddress: readAddress('ROG_CONTRACT_ADDRESS'), usdcContractAddress: readAddress('ROG_USDC_CONTRACT_ADDRESS'), amountUsdc: amount, chainId: Number(process.env.POLYGON_CHAIN_ID || 137), minConfirmations: Number(process.env.POLYGON_MIN_CONFIRMATIONS || 1) };
}
async function assertReceiptConfirmed(txHash, dependencies = {}) {
  const p = dependencies.provider || getProvider(); const cfg = dependencies.config || getConfig(); const network = await p.getNetwork();
  if (Number(network.chainId) !== cfg.chainId) throw makeError(`Rete ROG errata: attesa chainId ${cfg.chainId}`, 'ROG_DONATION_WRONG_NETWORK');
  const receipt = await p.getTransactionReceipt(txHash); if (!receipt) throw makeError('Transazione ROG non ancora confermata', 'ROG_DONATION_PENDING', true);
  if (Number(receipt.status) !== 1) throw makeError('Transazione ROG fallita on-chain', 'ROG_DONATION_REVERTED');
  const current = await p.getBlockNumber(); const confirmations = Number(current) - Number(receipt.blockNumber) + 1;
  if (!Number.isInteger(confirmations) || confirmations < cfg.minConfirmations) throw makeError('Conferme blockchain ROG insufficienti', 'ROG_DONATION_PENDING', true);
  return { receipt, confirmations, config: cfg, provider: p };
}
async function verifyRogUsdcTransfer({ txHash, wallet, amountUsdc }, dependencies = {}) {
  const hash = normalizeHash(txHash, 'rogUsdcTxHash'); const donor = normalizeWallet(wallet); const amount = Number(amountUsdc);
  const { receipt, confirmations, config: cfg } = await assertReceiptConfirmed(hash, dependencies);
  if (String(receipt.from || '').toLowerCase() !== donor) throw makeError('Mittente della donazione ROG non corrispondente al wallet', 'ROG_DONATION_SENDER_MISMATCH');
  const expectedAmount = ethers.parseUnits(String(amount), 6); const iface = new ethers.Interface(ERC20_ABI); let matching = 0n; const logIndexes = [];
  for (const log of receipt.logs || []) { if (String(log.address || '').toLowerCase() !== cfg.usdcContractAddress) continue; try { const parsed = iface.parseLog(log); if (!parsed || parsed.name !== 'Transfer') continue; const from = String(parsed.args.from).toLowerCase(); const to = String(parsed.args.to).toLowerCase(); if (from === donor && to === cfg.treasuryWallet) { matching += BigInt(parsed.args.value.toString()); logIndexes.push(Number(log.index ?? log.logIndex ?? -1)); } } catch (_) {} }
  if (matching !== expectedAmount) throw makeError(`Donazione ROG non valida: attesi esattamente ${amount} USDC verso Cassa ROG`, 'ROG_DONATION_TRANSFER_NOT_VERIFIED');
  const block = await (dependencies.provider || getProvider()).getBlock(receipt.blockNumber);
  const blockTimestamp = block?.timestamp == null ? null : Number(block.timestamp);
  return { txHash: hash, wallet: donor, amountUsdc: amount, amountBaseUnits: matching.toString(), recipient: cfg.treasuryWallet, tokenContract: cfg.usdcContractAddress, blockNumber: Number(receipt.blockNumber), blockHash: receipt.blockHash, blockTimestamp, confirmations, logIndexes };
}
async function verifyRogRegistration({ registerTxHash, wallet, amountUsdc, donationId }, dependencies = {}) {
  const hash = normalizeHash(registerTxHash, 'rogRegisterTxHash'); const donor = normalizeWallet(wallet); const id = String(donationId || '').trim();
  if (!/^\d+$/.test(id) || BigInt(id) <= 0n) throw makeError('rogDonationId non valido', 'ROG_DONATION_ID_INVALID');
  const amount = Number(amountUsdc); const { receipt, confirmations, config: cfg, provider: p } = await assertReceiptConfirmed(hash, dependencies);
  if (String(receipt.from || '').toLowerCase() !== donor) throw makeError('registerDonation ROG non firmata dal wallet atteso', 'ROG_REGISTER_SENDER_MISMATCH');
  const iface = new ethers.Interface(ROG_ABI); const expectedAmount = ethers.parseUnits(String(amount), 6); let eventProof = null;
  for (const log of receipt.logs || []) { if (String(log.address || '').toLowerCase() !== cfg.contractAddress) continue; try { const parsed = iface.parseLog(log); if (!parsed || parsed.name !== 'DonationRegistered') continue; const eventId = BigInt(parsed.args.donationId.toString()); const eventDonor = String(parsed.args.donor).toLowerCase(); const eventAmount = BigInt(parsed.args.amount.toString()); if (eventId === BigInt(id) && eventDonor === donor && eventAmount === expectedAmount) { eventProof = { donationId: id, donor, amountBaseUnits: eventAmount.toString(), blockNumber: Number(receipt.blockNumber), confirmations }; break; } } catch (_) {} }
  if (!eventProof) throw makeError('Evento DonationRegistered ROG non coerente con wallet/importo/donationId', 'ROG_REGISTER_EVENT_NOT_VERIFIED');
  const block = await (dependencies.provider || getProvider()).getBlock(receipt.blockNumber);
  eventProof.blockTimestamp = block?.timestamp == null ? null : Number(block.timestamp);
  // Il contratto ROG live non espone in modo affidabile getDonation(uint256).
  // La prova autorevole e il receipt status=1 firmato dal donor con l'evento
  // DonationRegistered esatto per donationId/importo. Non aggiungere fallback
  // a getDonation(): il backend ROG usa la stessa prova receipt-backed.
  return { txHash: hash, ...eventProof, receiptVerified: true };
}
async function finalizeRogDonation({ wallet, amountUsdc, usdcTxHash, registerTxHash, donationId }) {
  const donor = normalizeWallet(wallet);
  const registrationHash = normalizeHash(registerTxHash, 'rogRegisterTxHash');
  const registerPayload = await rogApi._rogRequest('/api/donation/register', { method: 'POST', timeoutMs: Number(process.env.ROG_API_TIMEOUT_MS || 30000), body: { donationId: String(donationId), donor, amount: Number(amountUsdc), txHash: normalizeHash(usdcTxHash, 'rogUsdcTxHash'), registerTxHash: registrationHash, donationType: 'standard' } });
  let completion; try { completion = await rogApi._rogRequest('/api/donation/verify', { method: 'POST', timeoutMs: Number(process.env.ROG_COMPLETION_API_TIMEOUT_MS || 25000), body: { donationId: String(donationId) } }); } catch (error) { const payload = error?.payload || null; const pending = payload?.status === 'ONCHAIN_COMPLETION_PENDING' || payload?.retryable === true; if (pending || error?.message?.includes('ONCHAIN_COMPLETION_PENDING')) throw makeError('Completamento ROG ancora in conferma on-chain. Riprovare.', 'ROG_DONATION_COMPLETION_PENDING', true); throw error; }
  if (completion?.success !== true || completion?.status !== 'COMPLETED') throw makeError('ROG non ha confermato la donazione come COMPLETED', 'ROG_DONATION_NOT_COMPLETED', true);
  if (String(completion.rgxOwnerWallet || '').toLowerCase() !== donor) throw makeError('ROG ha attribuito la donazione a un wallet differente', 'ROG_DONATION_OWNER_MISMATCH');
  if (!Number.isFinite(Number(completion.rgxMinted)) || Number(completion.rgxMinted) < 1) throw makeError('ROG non ha confermato almeno 1 RGX per la donazione', 'ROG_DONATION_RGX_NOT_VERIFIED');
  const readback = await rogApi._rogRequest(`/api/donation/status/${encodeURIComponent(donor)}`, { timeoutMs: Number(process.env.ROG_API_TIMEOUT_MS || 30000) });
  if (readback?.hasDonated !== true) throw makeError('Read-back ROG non conferma la donazione', 'ROG_DONATION_READBACK_FAILED', true);
  return { success: true, register: registerPayload, completion, readback };
}
module.exports = { ROG_ABI, getConfig, verifyRogUsdcTransfer, verifyRogRegistration, finalizeRogDonation, _assertReceiptConfirmed: assertReceiptConfirmed };
