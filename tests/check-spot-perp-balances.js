import HyperliquidConnector from '../hyperliquid.js';

async function checkBalances() {
  const hyperliquid = new HyperliquidConnector({ testnet: false });

  console.log('Wallet address:', hyperliquid.wallet);
  console.log();

  try {
    // Check perp balances
    console.log('=== PERP ACCOUNT ===');
    const perpResponse = await fetch(hyperliquid.restUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: hyperliquid.wallet })
    });
    const perpData = await perpResponse.json();
    console.log('Account value:', perpData.marginSummary?.accountValue || 'N/A');
    console.log('Withdrawable:', perpData.withdrawable || 'N/A');
    console.log('Positions:', perpData.assetPositions?.length || 0);
    if (perpData.assetPositions && perpData.assetPositions.length > 0) {
      perpData.assetPositions.forEach(pos => {
        console.log(`  ${pos.position.coin}: ${pos.position.szi} (entry: $${pos.position.entryPx})`);
      });
    }
    console.log();

    // Check spot balances
    console.log('=== SPOT ACCOUNT ===');
    const spotResponse = await fetch(hyperliquid.restUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: hyperliquid.wallet })
    });
    const spotData = await spotResponse.json();
    console.log('Spot balances:', spotData.balances?.length || 0);
    if (spotData.balances && spotData.balances.length > 0) {
      spotData.balances.forEach(bal => {
        const amount = bal.total || bal.hold;
        console.log(`  ${bal.coin}: ${amount}`);
      });
    } else {
      console.log('  No spot balances');
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkBalances();
