'use strict';
/** Compatibility boundary for the historical THOT/ISIDE allocation columns.
 * There is NO receiver-owned HUMAN generation path or unsafe legacy fallback.
 */
const A=require('./economic-amounts');
async function materializzaRientriEntrata({source,eventKey,sourceAccountId,count,client}) {
  if(!client)throw A.error('GENERATED_S0_TRANSACTION_REQUIRED');
  const level=source==='THOT_REENTRY'?'THOT':source==='ISIDE_REENTRY'?'ISIDE':null;
  if(!level || Number(count)!==(level==='THOT'?5:50))throw A.error('GENERATED_S0_QUOTA_INVALID');
  const flow=require('./economic-flow').configuredFlow(client);
  const result=await flow.materializeQuota({eventKey,source:level,accountId:sourceAccountId});
  return result.positions.map(p=>({index:p.index,accountId:p.accountId,accountSigla:p.sigla,
    numeroPosizionale:p.number,positionClass:p.positionClass,ownerWallet:p.ownerWallet,
    sourceAccountId,sourceEventKey:eventKey,automaticReceiverReentry:false,
    tavola:{id:p.tableId,numero:p.tableNumber,casella:p.slot,completa:p.completed},
    tavolaPersonale:{id:p.personalTableId,numero:p.personalTableNumber}}));
}
module.exports={materializzaRientriEntrata};
