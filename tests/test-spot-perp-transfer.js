import { requireLiveTradingTest } from '../utils/live-guard.js';
requireLiveTradingTest('tests/test-spot-perp-transfer.js');
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

/**
 * Test script to transfer USDC between Spot and Perp accounts on Hyperliquid
 *
 * This script demonstrates how to:
 * 1. Sign a usdClassTransfer action using EIP-712
 * 2. Transfer funds from Spot to Perp (or vice versa)
 */

const HL_WALLET = process.env.HL_WALLET;
const HL_PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const API_URL = 'https://api.hyperliquid.xyz/exchange';

// Configuration
const TRANSFER_AMOUNT = '1'; // Amount in USDC to transfer
const TO_PERP = true; // true = Spot -> Perp, false = Perp -> Spot

async function signUsdClassTransfer(action, privateKey) {
  const wallet = new ethers.Wallet(privateKey);

  // EIP-712 Domain
  const domain = {
    name: 'HyperliquidSignTransaction',
    version: '1',
    chainId: 42161, // Arbitrum chainId
    verifyingContract: '0x0000000000000000000000000000000000000000'
  };

  // EIP-712 Types for UsdClassTransfer
  const types = {
    'HyperliquidTransaction:UsdClassTransfer': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'toPerp', type: 'bool' },
      { name: 'nonce', type: 'uint64' }
    ]
  };

  // Message to sign (order matters - must match the types order)
  const message = {
    hyperliquidChain: action.hyperliquidChain,
    amount: action.amount,
    toPerp: action.toPerp,
    nonce: action.nonce
  };

  // Sign the typed data with the primaryType
  const signature = await wallet.signTypedData(
    domain,
    types,
    message
  );

  const sig = ethers.Signature.from(signature);

  return {
    r: sig.r,
    s: sig.s,
    v: sig.v
  };
}

async function transferBetweenSpotAndPerp(amount, toPerp) {
  console.log('='.repeat(80));
  console.log('Hyperliquid Spot <-> Perp Transfer Test');
  console.log('='.repeat(80));
  console.log();
  console.log(`Wallet:    ${HL_WALLET}`);
  console.log(`Amount:    $${amount} USDC`);
  console.log(`Direction: ${toPerp ? 'Spot → Perp' : 'Perp → Spot'}`);
  console.log();

  // Validate credentials
  if (!HL_WALLET || !HL_PRIVATE_KEY) {
    throw new Error('Missing HL_WALLET or HL_PRIVATE_KEY in .env file');
  }

  // Create action
  const nonce = Date.now();
  const action = {
    type: 'usdClassTransfer',
    hyperliquidChain: 'Mainnet',
    signatureChainId: '0xa4b1', // Arbitrum chain ID in hex
    amount: amount,
    toPerp: toPerp,
    nonce: nonce
  };

  console.log('Action:', JSON.stringify(action, null, 2));
  console.log();

  // Sign the action
  console.log('[SIGNING] Signing transfer action with EIP-712...');
  const signature = await signUsdClassTransfer(action, HL_PRIVATE_KEY);
  console.log('[SIGNING] ✅ Signature generated');
  console.log(`  r: ${signature.r}`);
  console.log(`  s: ${signature.s}`);
  console.log(`  v: ${signature.v}`);
  console.log();

  // Prepare request
  const request = {
    action: action,
    nonce: nonce,
    signature: signature
  };

  console.log('[API] Sending transfer request...');
  console.log('Request:', JSON.stringify(request, null, 2));
  console.log();

  // Send request
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request)
    });

    const result = await response.json();

    console.log('[API] Response received:');
    console.log(JSON.stringify(result, null, 2));
    console.log();

    if (result.status === 'ok') {
      console.log('✅ Transfer successful!');
      console.log(`   ${toPerp ? 'Spot → Perp' : 'Perp → Spot'}: $${amount} USDC`);
    } else {
      console.error('❌ Transfer failed!');
      console.error('Error:', result);
    }
  } catch (error) {
    console.error('❌ Request failed:', error.message);
    throw error;
  }

  console.log();
  console.log('='.repeat(80));
  console.log('Test completed.');
  console.log('='.repeat(80));
}

// Run the test
transferBetweenSpotAndPerp(TRANSFER_AMOUNT, TO_PERP)
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
