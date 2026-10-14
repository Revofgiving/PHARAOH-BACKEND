'use strict';
/**
 * Source: note for Giovanni, 7 October, sections 2-7 and 9.
 * Pure planning only. Counters MUST be read/updated in the SAME transaction as
 * actual S0 materialization; these functions do not persist positions or money.
 * THOT is explicitly included by the written user confirmation of 8 October.
 * The latest confirmation supersedes legacy receiver-owned HUMAN reentries.
 */
const UNIT_ATOMIC = 100n * 1000000n;
const SOURCES = Object.freeze(['THOT', 'ISIDE', 'PILETTA_REINVESTMENT']);
function exactCount(value, label) {
  let result;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) result = BigInt(value);
  else throw new Error(`INVALID_${label}`);
  if (result < 0n) throw new Error(`INVALID_${label}`);
  return result;
}
function classifyGeneratedBatch({source, amountAtomic, settledAvailableAtomic, humanExternalCumulative, pilettaS0Cumulative}) {
  if (!SOURCES.includes(source)) throw new Error('SOURCE_NOT_DEFINED_BY_PILETTA_NOTE');
  if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n || amountAtomic % UNIT_ATOMIC !== 0n) {
    throw new Error('GENERATED_VALUE_NOT_WHOLE_S0_UNITS');
  }
  if (typeof settledAvailableAtomic !== 'bigint' || settledAvailableAtomic < 0n || settledAvailableAtomic < amountAtomic) {
    throw new Error('INSUFFICIENT_UNRESERVED_SETTLED_VALUE');
  }
  const human = exactCount(humanExternalCumulative, 'EXTERNAL_HUMAN_COUNT');
  const piletta = exactCount(pilettaS0Cumulative, 'PILETTA_COUNT');
  if (piletta > human) throw new Error('S0_CAP_ALREADY_EXCEEDED_RECONCILIATION_REQUIRED');
  const total = amountAtomic / UNIT_ATOMIC;
  const margin = human - piletta;
  const pilettaToCreate = total < margin ? total : margin;
  return Object.freeze({
    status: 'PLAN_ONLY_NO_POSITIONS_CREATED', source, totalToCreate: total,
    pilettaToCreate, fondoAToCreate: total - pilettaToCreate,
    coveredAtomic: amountAtomic, unusedAtomic: 0n, externalHumanDelta: 0n,
    projectedPilettaAfterAtomicMaterialization: piletta + pilettaToCreate,
    humanExternalUnchanged: human, reclassifyExistingFondoA: false
  });
}
module.exports = {UNIT_ATOMIC, SOURCES, exactCount, classifyGeneratedBatch};
