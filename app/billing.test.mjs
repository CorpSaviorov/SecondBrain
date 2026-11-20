import {test} from 'node:test';import assert from 'node:assert/strict';import {billingRates,chargeUsage} from './billing.mjs';
test('unified balance accounts route multiplier, purchase-unit price, FX and conservative margin',()=>{
 const c={billing_mode:'balance-units',balance_multiplier:.5,rub_per_million_balance_units:600/80.76,rub_per_usd:82.1516,billing_margin:1.25},rates=billingRates(c);
 assert.equal(rates.input,rates.output);assert.ok(Math.abs(chargeUsage({input_tokens:1000000,output_tokens:1000000},rates,1)-(600/80.76)/82.1516*1.25)<1e-10);assert.equal(billingRates({...c,rub_per_usd:null}),null);assert.equal(billingRates({...c,billing_margin:.9}),null);assert.equal(chargeUsage({},rates,.2),.2);
});
