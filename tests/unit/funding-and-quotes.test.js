import test from 'node:test';
import assert from 'node:assert/strict';
import HyperliquidConnector from '../../hyperliquid.js';
import { validateFundingWindow, getFundingRatesWithHistory } from '../../utils/funding.js';
import { getCurrentPositionFundingSignal } from '../../utils/position-decision.js';

const HOUR = 3600000;
function hours() {
  const end = Date.now();
  return Array.from({length:168},(_,i)=>({time:(Math.floor(end/HOUR)-167+i)*HOUR,fundingRate:'0.0000125'}));
}

test('seven-day funding validation rejects missing, duplicated, gapped, non-finite and out-of-window records', () => {
  const rows=hours(), end=Date.now(), start=end-168*HOUR;
  validateFundingWindow(rows,start,end);
  for(const bad of [[], rows.slice(1), [...rows.slice(1),rows[1]],
    rows.map((r,i)=>i===80?{...r,time:r.time+2*HOUR}:r),
    rows.map((r,i)=>i===80?{...r,fundingRate:'NaN'}:r),
    rows.map((r,i)=>i===0?{...r,time:start-1}:r)]) {
    assert.throws(()=>validateFundingWindow(bad,start,end));
  }
});

test('funding history errors and empty history never fall back to a negative current hour', async () => {
  for(const outcome of ['timeout','empty','partial','valid']) {
    const rates=await getFundingRatesWithHistory({infoRequest:async ({type})=>{
      if(type==='metaAndAssetCtxs')return [{universe:[{name:'BTC'}]},[{funding:'-0.001'}]];
      if(outcome==='timeout')throw Error('history timeout');
      return outcome==='empty'?[]:outcome==='partial'?hours().slice(1):hours();
    }},['BTC']);
    const signal=getCurrentPositionFundingSignal({symbol:'BTC'},{rankedOpportunities:[],marketData:{fundingRates:rates}});
    assert.equal(signal.available,outcome==='valid');
    if(signal.available) assert.ok(signal.fundingRate>0);
  }
});

function connector() {
  const c=new HyperliquidConnector({wallet:'audit-fake',privateKey:null,fetch:async()=>{throw Error('Network disabled');}});
  c.signer={};
  c.metaCache={universe:[{name:'BTC',szDecimals:4}]};
  c.spotMetaCache={tokens:[{index:1,name:'UBTC',szDecimals:4}],universe:[{index:0,name:'@0',tokens:[1,0]}]};
  c.sent=[];c.createOrderRest=async action=>{c.sent.push(action);return {status:'ok'};};
  return c;
}

for(const [name, side, isSpot, reduceOnly] of [['open perp','sell',false,false],['close perp','buy',false,true],['spot buy','buy',true,false],['spot cleanup','sell',true,false]]) {
  test(`${name}: old override cannot bypass freshness; stale or crossed REST books reject orders`,async()=>{
    const c=connector();const coin=isSpot?'UBTC':'BTC';
    await assert.rejects(c.createMarketOrder(coin,side,1,{isSpot,reduceOnly,overrideMidPrice:100}),/unsupported/);
    for(const [bid,ask,time] of [[99,101,Date.now()-20000],[101,99,Date.now()],[0,1,Date.now()]]){
      c.orderbooks.clear();
      c.requestL2BookRest=async()=>({levels:[[{px:String(bid),sz:'10'}],[{px:String(ask),sz:'10'}]],time});
      await assert.rejects(c.createMarketOrder(coin,side,1,{isSpot,reduceOnly}),/fresh valid/);
    }
    assert.equal(c.sent.length,0);
    c.requestL2BookRest=async()=>({levels:[[{px:'99.99',sz:'10'}],[{px:'100.01',sz:'10'}]],time:Date.now()});
    await c.createMarketOrder(coin,side,1,{isSpot,reduceOnly});
    assert.equal(c.sent.length,1);
  });
}
