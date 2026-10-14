'use strict';
/** PHARAOH S0: classificazione pura per eventi THOT/ISIDE. Nessun side effect. */
const {classifyGeneratedBatch} = require('./s0-generated-batch-policy');
const CONFIG = Object.freeze({ THOT: Object.freeze({amountUsdc:500, count:5}), ISIDE:Object.freeze({amountUsdc:5000,count:50}) });
function validCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_${name}`);
  return value;
}
function classify({source, humanExternalCumulative, pilettaS0Cumulative, settledUsdc}) {
  const cfg = CONFIG[String(source || '').toUpperCase()];
  if (!cfg) throw new Error('INVALID_SOURCE');
  const human = validCount(humanExternalCumulative, 'HUMAN_COUNT');
  const piletta = validCount(pilettaS0Cumulative, 'PILETTA_COUNT');
  if (piletta > human) throw new Error('S0_CAP_ALREADY_EXCEEDED');
  if (!Number.isSafeInteger(settledUsdc) || settledUsdc < cfg.amountUsdc) throw new Error('INSUFFICIENT_SETTLED_USDC');
  const plan = classifyGeneratedBatch({source:String(source).toUpperCase(),
    amountAtomic:BigInt(cfg.amountUsdc)*1000000n, settledAvailableAtomic:BigInt(settledUsdc)*1000000n,
    humanExternalCumulative:human, pilettaS0Cumulative:piletta});
  return Object.freeze({source:String(source).toUpperCase(), amountUsdc:cfg.amountUsdc, total:cfg.count,
    piletta:Number(plan.pilettaToCreate), fondoA:Number(plan.fondoAToCreate), coveredUsdc:cfg.count*100});
}
module.exports = { CONFIG, classify };
