'use strict';
/** CONTINUITA_RHA is a 500-USDC economic slot, never an account or a wallet. */
const A=require('./economic-amounts');
function assertReservation(r) {
  if(!r || r.tipo_funzione!=='CONTINUITA_RHA' || r.funzione_id!=null || r.account_destinazione_id!=null ||
    r.account_destinazione_wallet!=null || r.numero_posizionale!=null || Number(r.livello_destinazione)!==3 ||
    Number(r.tavola_relativa)!==7 || Number(r.casella)!==2)throw A.error('CONTINUITY_IDENTITY_OR_SLOT_INVALID');
}
async function reserve({account,turnNumber},client) {
  if(!client)throw A.error('CONTINUITY_TRANSACTION_REQUIRED');
  if(account?.tipo!=='PERPETUO')throw A.error('CONTINUITY_ONLY_AFTER_PERPETUO');
  const ledger=require('./economic-ledger').configuredLedger(client);await ledger.ready();
  const current=Number(turnNumber);
  if(!Number.isSafeInteger(current)||current<1||!Number.isSafeInteger(current+1))throw A.error('CONTINUITY_TURN_INVALID');
  A.positive(account.id,'ACCOUNT_ID');
  const destination=current+1;
  const movement=await ledger.store.movement(`GEMELLI_RETURN:${turnNumber}`);
  if(!movement || movement.purpose!=='CONTINUITY_IN' || A.atomic(movement.amount_atomic)!==A.usdc('500'))throw A.error('CONTINUITY_PREFUNDING_REQUIRED');
  const row=await require('./db-manager').createPrenotazioneFunzione({eventKey:`CONTINUITY:${turnNumber}:${account.id}`,
    funzioneId:null,tipoFunzione:'CONTINUITA_RHA',accountOrigineWallet:account.wallet,accountOrigineId:account.id,
    accountDestinazioneWallet:null,accountDestinazioneId:null,turnoOrigine:turnNumber,turnoDestinazione:destination,
    livelloDestinazione:3,bloccoDestinazione:1,tavolaRelativa:7,tavolaNumero:null,casella:2,numeroPosizionale:null},client);
  assertReservation(row);
  if(String(row.account_origine_id)!==String(account.id)||Number(row.turno_destinazione)!==destination)throw A.error('CONTINUITY_SOURCE_CONFLICT');
  return row;
}
async function materialize({reservation,table,turnNumber},client) {
  assertReservation(reservation);
  if(!client)throw A.error('CONTINUITY_TRANSACTION_REQUIRED');
  const ledger=require('./economic-ledger').configuredLedger(client);await ledger.ready();
  if(!Number.isSafeInteger(Number(turnNumber)) || Number(turnNumber)<2 || Number(reservation.turno_destinazione)!==Number(turnNumber) ||
     Number(table.livello)!==3 || Number(table.turno)!==Number(turnNumber) ||
     (reservation.tavola_numero!=null && Number(reservation.tavola_numero)!==Number(table.numero)))throw A.error('CONTINUITY_TABLE_MISMATCH');
  const t=(await client.query("SELECT id FROM turni WHERE sezione='PHARAOH' AND livello=1 AND numero_turno=$1",[turnNumber])).rows[0];
  const funding=t&&await ledger.store.event(`FUNCTIONS_TO_B1:${t.id}`);
  if(!funding || funding.status!=='COMPLETED')throw A.error('CONTINUITY_FUNDED_TURN_REQUIRED');
  const slot=(await client.query('SELECT * FROM posizioni WHERE tavola_id=$1 AND casella=2',[table.id])).rows[0];
  let position=slot;
  if(slot) {
    if(reservation.posizione_id!=null && String(reservation.posizione_id)!==String(slot.id))throw A.error('CONTINUITY_POSITION_CONFLICT');
    if(slot.tipo!=='CONTINUITA_RHA'||slot.wallet!=null||slot.account_id!=null||slot.account_sigla!=null||slot.numero_posizionale!=null||slot.sdoppiamento_tavola_id!=null||Number(slot.dono_importo)!==500)throw A.error('CONTINUITY_SLOT_ALREADY_OCCUPIED');
  } else {
    const first=(await client.query('SELECT id FROM posizioni WHERE tavola_id=$1 AND casella=1',[table.id])).rows[0];
    if(!first)throw A.error('CONTINUITY_PRECEDING_SLOT_REQUIRED');
    position=await require('./db-manager').createPosizione({tavolaId:table.id,casella:2,wallet:null,nome:'CONTINUITA RHA',tipo:'CONTINUITA_RHA',donoImporto:500},client);
    await client.query('UPDATE tavole SET doni_ricevuti=doni_ricevuti+500 WHERE id=$1',[table.id]);
  }
  await client.query(`UPDATE tavole SET status='COMPLETATA' WHERE id=$1 AND capacita<=(SELECT count(*) FROM posizioni WHERE tavola_id=$1 AND tipo<>'EREDE')`,[table.id]);
  await client.query(`UPDATE prenotazioni_funzioni SET stato='MATERIALIZED',posizione_id=$1,tavola_numero=$2,
    materialized_at=COALESCE(materialized_at,now()),updated_at=now() WHERE id=$3`,[position.id,table.numero,reservation.id]);
  // Deliberately no accounts, identita_funzioni, sigle, numbers or split tables.
  return position;
}
module.exports={reserve,materialize,assertReservation};
