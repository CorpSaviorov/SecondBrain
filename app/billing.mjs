// Budget accounting supports the user's unified-balance route as well as explicit USD token prices.
export function billingRates(config){
 if(config.billing_mode==='balance-units'){
  const {balance_multiplier:multiplier,rub_per_million_balance_units:rub,rub_per_usd:fx,billing_margin:margin}=config;
  if(![multiplier,rub,fx,margin].every(n=>Number.isFinite(n)&&n>0)||margin<1) return null;
  const usd=multiplier*rub/fx*margin;return {input:usd,output:usd,mode:'balance-units',multiplier,rub,fx,margin};
 }
 return config.input_usd_per_million!==null&&config.output_usd_per_million!==null?{input:config.input_usd_per_million,output:config.output_usd_per_million,mode:'usd-tokens'}:null;
}
export function chargeUsage(usage,rates,fallback){
 const input=usage.input_tokens??usage.prompt_tokens,output=usage.output_tokens??usage.completion_tokens;
 if(!Number.isFinite(input)||!Number.isFinite(output)||input<0||output<0)return fallback;
 return (input*rates.input+output*rates.output)/1e6;
}
