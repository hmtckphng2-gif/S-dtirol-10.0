/* Südtirol Radar 10.0 — Live Journey Intelligence.
 *
 * Reine, regelbasierte Prognosen ohne erfundene Daten. Keine Machine-Learning-Infrastruktur.
 * Unterscheidet klar:
 *   - gemeldete Feed-Verspätung (GTFS-RT delay)
 *   - geschätzte Ankunftsverspätung (regelbasiert aus Position + Fahrplan)
 *   - räumliche Abweichung zur planmäßigen Position (Meter auf GTFS-Strecke)
 *   - Datenvertrauen (aktuell / geschätzt / veraltet / widersprüchlich / unbekannt)
 *
 * Jede Prognose hat eine erkennbare Datenbasis und einen Zeitbezug.
 * Wenn keine belastbare Prognose möglich ist, wird "Keine verlässliche Prognose" zurückgegeben.
 */

import {romeSeconds,romeDay,dateGTFSValid} from './radar51-logic.mjs?v=9.9.0';
import {trainScheduledPosition} from './radar51-logic.mjs?v=9.9.0';
import {vehicleDelayInfo,feedAgeSeconds,tripUpdateMatches} from './core.js?v=9.9.0';
import {delaySeverity,isSevereDelay} from './radar52-logic.mjs?v=9.9.0';

const FRESH_MAX_AGE = 60;
const STALE_MAX_AGE = 300;
const MAX_PROJECTION_STOPS = 8;
const MAX_SPEED_KMH = 160;

export const TRUST = Object.freeze({
  current: 'aktuell',
  estimated: 'geschätzt',
  stale: 'veraltet',
  conflicting: 'widersprüchlich',
  unknown: 'unbekannt'
});

export const FORECAST_QUALITY = Object.freeze({
  high: 'hoch',
  medium: 'mittel',
  low: 'niedrig',
  none: 'keine'
});

export function buildJourney(vehicle,indexes,details,shapes,updates,statuses,nowMs=Date.now()){
  if(!vehicle)return null;
  const nowSec=Math.floor(nowMs/1000);       // Unix-Zeit (für feedAgeSeconds, positionQuality)
  const nowDaySec=romeSeconds(new Date(nowMs)); // Sekunden seit Mitternacht (für Vergleich mit GTFS times)
  const source=vehicle.source;
  const db=indexes?.[source];
  const det=details?.[source];
  const tripId=vehicle.tripId;

  if(!tripId||!db||!dateGTFSValid(db,new Date(nowMs)))return null;
  const trip=db.trips?.[tripId];
  if(!trip||trip[5]===false)return null;

  const route=db.routes?.[trip[0]];
  const kind=vehicle.kind;
  const line=kind==='train'?(trip[3]||route?.[0]||'Zug'):(route?.[0]||'Linie unbekannt');
  const headsign=trip[1]||vehicle.headsign||'Ziel unbekannt';
  const today=romeDay(new Date(nowMs)).replaceAll('-','');

  if(vehicle.tripStartDate&&String(vehicle.tripStartDate).replaceAll('-','')!==today)return null;

  const update=updates?.[source+':'+tripId];
  const updateFresh=update&&tripUpdateMatches(vehicle,update)&&
    Number.isFinite(Number(update.fetchedAt))&&
    nowMs-Number(update.fetchedAt)<=120000&&
    nowMs>=Number(update.fetchedAt)-30000;

  const times=det?.times?.[tripId];
  const stops=det?.stops||{};
  if(!Array.isArray(times)||times.length<2)return null;

  const posAge=feedAgeSeconds(vehicle,nowMs);
  const feedUpdatesOk=statuses?.[source+'_updates']==='ok';
  const posQuality=positionQuality(vehicle,nowSec,feedUpdatesOk);
  const delayInfo=vehicleDelayInfo(update,vehicle);
  const feedDelaySec=delayInfo?delayInfo.delay:null;
  const feedDelayBasis=delayInfo?delayInfo.basis:null;

  const currentSeq=Number.isFinite(Number(vehicle.currentStopSequence))?Number(vehicle.currentStopSequence):null;
  const currentStopId=vehicle.currentStopId||null;
  const nextStopIndex=findNextStopIndex(times,currentSeq,currentStopId,nowDaySec);

  const upcoming=[];
  if(nextStopIndex>=0){
    for(let i=nextStopIndex;i<times.length&&upcoming.length<MAX_PROJECTION_STOPS;i++){
    const [stopId,arrSec,depSec,seq]=times[i];
    const st=stops?.[stopId];
    if(!st)continue;
    const stopName=String(st[0]||stopId);
    const stopLat = st[1] === null || st[1] === undefined ? null : Number(st[1]);
    const stopLon = st[2] === null || st[2] === undefined ? null : Number(st[2]);

    const plannedArr=arrSec===null||arrSec===undefined?null:Number(arrSec);
    const plannedDep=depSec===null||depSec===undefined?null:Number(depSec);

    const forecast=estimateStopForecast(
      vehicle,update,updateFresh,plannedArr,plannedDep,stopId,seq,i,times,
      nowSec,posAge,feedDelaySec,feedDelayBasis,db
    );

    upcoming.push({
      stopId:String(stopId),
      name:stopName,
      lat:Number.isFinite(stopLat)?stopLat:null,
      lon:Number.isFinite(stopLon)?stopLon:null,
      seq:Number.isFinite(seq)?seq:null,
      plannedArr,plannedDep,
      forecastArr:forecast.arr,forecastDep:forecast.dep,
      forecastQuality:forecast.quality,
      forecastBasis:forecast.basis,
      delaySec:forecast.delay,
      delayMinutes:forecast.delay===null?null:Math.round(forecast.delay/60),
      isCurrent:i===nextStopIndex,
      isSkipped:update&&Array.isArray(update.stops)&&update.stops.some(s=>
        String(s.stopId??s.stop_id)===String(stopId)&&/^(SKIPPED|1)$/i.test(String(s.scheduleRelationship??s.schedule_relationship??'')))
    });
  }
  }

  const schedule=trainScheduledPosition(vehicle,indexes,details,shapes,new Date(nowMs));
  const spatialDeviation=schedule?{
    differenceKm:schedule.differenceKm,
    relative:schedule.relative,
    from:schedule.from,
    to:schedule.to,
    plannedMeters:schedule.plannedMeters,
    observedMeters:schedule.observedMeters,
    note:schedule.note
  }:null;

  const delayEvolution=buildDelayEvolution(update,times,nowSec,stops);

  const trust=journeyTrust(vehicle,posAge,posQuality,feedUpdatesOk,feedDelaySec,schedule,spatialDeviation,updateFresh);

  const nextStop=upcoming.length>0?upcoming[0]:null;

  return {
    source,kind,line,headsign,tripId,routeId:trip[0],shapeId:trip[2],serviceDay:trip[4],
    vehicleId:vehicle.vehicleId||null,
    position:{lat:vehicle.lat,lon:vehicle.lon,timestamp:vehicle.timestamp,ageSec:posAge,quality:posQuality,type:vehicle.positionType},
    feedDelaySec,feedDelayBasis,
    spatialDeviation,
    delayEvolution,
    trust,
    nextStop,
    upcoming,
    cancelled:update?/^(CANCELED|CANCELLED|3)$/i.test(String(update.scheduleRelationship||'')):false,
    updatedAt:nowMs
  };
}

function findNextStopIndex(times,currentSeq,currentStopId,nowSec){
  if(!Array.isArray(times))return -1;
  let nextIdx=-1;
  let minSec=Infinity;
  for(let i=0;i<times.length;i++){
    const [stopId,,plannedSec,seq]=times[i];
    const sec=Number(plannedSec??0);
    if(currentSeq!==null&&Number.isFinite(seq)&&seq<=currentSeq)continue;
    if(currentStopId&&String(stopId)===String(currentStopId))continue;
    if(sec<nowSec-180)continue;
    if(sec<minSec){minSec=sec;nextIdx=i;}
  }
  return nextIdx;
}

function estimateStopForecast(vehicle,update,updateFresh,plannedArr,plannedDep,stopId,seq,idx,times,nowSec,posAge,feedDelaySec,feedDelayBasis,db){
  const result={arr:null,dep:null,quality:FORECAST_QUALITY.none,basis:'keine',delay:null};

  if(plannedArr===null&&plannedDep===null)return result;

  if(update&&Array.isArray(update.stops)){
    const stopRow=update.stops.find(s=>String(s.stopId??s.stop_id)===String(stopId));
    if(stopRow){
      const arrDelay=stopRow.arrival?.delay??null;
      const depDelay=stopRow.departure?.delay??null;
      const arrValid=updateFresh&&Number.isFinite(arrDelay);
      const depValid=updateFresh&&Number.isFinite(depDelay);
      if(arrValid||depValid){
        result.arr=arrValid?plannedArr+arrDelay:null;
        result.dep=depValid?plannedDep+depDelay:null;
        result.delay=arrValid?arrDelay:(depValid?depDelay:null);
        result.basis='halt';
        result.quality=FORECAST_QUALITY.high;
        return result;
      }
    }
  }

  if(updateFresh&&feedDelaySec!==null){
    result.arr=plannedArr!==null?plannedArr+feedDelaySec:null;
    result.dep=plannedDep!==null?plannedDep+feedDelaySec:null;
    result.delay=feedDelaySec;
    result.basis='fahrt';
    result.quality=FORECAST_QUALITY.medium;
    return result;
  }

  if(posAge!==null&&posAge<=STALE_MAX_AGE&&vehicle.speed!==null&&vehicle.speed>0&&vehicle.speed<=MAX_SPEED_KMH){
    const distMeters=distanceToStop(vehicle.lat,vehicle.lon,stopId,db);
    if(distMeters!==null&&distMeters>0){
      const speedMs=vehicle.speed/3.6;
      const estSeconds=Math.round(distMeters/speedMs);
      const base=plannedArr!==null?plannedArr:(plannedDep!==null?plannedDep:null);
      if(base!==null){
        result.arr=base+estSeconds;
        result.dep=plannedDep!==null?plannedDep+estSeconds:null;
        result.delay=estSeconds;
        result.basis='position';
        result.quality=FORECAST_QUALITY.low;
        return result;
      }
    }
  }

  result.quality=FORECAST_QUALITY.none;
  return result;
}

function distanceToStop(vehLat,vehLon,stopId,db){
  if(!Number.isFinite(vehLat)||!Number.isFinite(vehLon))return null;
  if(!db||!db.stops)return null;
  const st=db.stops[stopId];
  if(!st||!Array.isArray(st)||st.length<2)return null;
  const lat=Number(st[1]),lon=Number(st[2]);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;
  const dLat=(vehLat-lat)*111195;
  const dLon=(vehLon-lon)*111195*Math.cos(lat*Math.PI/180);
  return Math.hypot(dLat,dLon);
}

function buildDelayEvolution(update,times,nowSec,stops){
  const points=[];
  if(update&&Array.isArray(update.stops)){
    for(const st of update.stops){
      const d=vehicleDelayInfo(update,{currentStopId:st.stopId??st.stop_id,currentStopSequence:st.stopSequence,currentStatus:st.scheduleRelationship||''});
      if(d&&Number.isFinite(d.delay)){
        points.push({stopId:String(st.stopId??st.stop_id),delaySec:d.delay,delayMinutes:Math.round(d.delay/60),basis:d.basis});
      }
    }
  }
  if(points.length===0)return null;
  const first=points[0],last=points[points.length-1];
  let trend='stabil';
  if(last.delaySec-first.delaySec>120)trend='vergrößert';
  else if(last.delaySec-first.delaySec<-120)trend='verringert';
  return {points,trend,firstDelay:first.delayMinutes,lastDelay:last.delayMinutes};
}

export function journeyTrust(vehicle,posAge,posQuality,feedOk,feedDelaySec,schedule,spatialDeviation,updateFresh){
  const posAgeSec=posAge!==null?posAge:Infinity;

  let conflicting=false;
  if(spatialDeviation&&feedDelaySec!==null&&vehicle.speed!==null&&vehicle.speed>0){
    const spatialMin=Math.round(spatialDeviation.differenceKm*1000/(vehicle.speed/3.6)/60);
    if(Math.abs(feedDelaySec/60-spatialMin)>10&&feedDelaySec>0&&spatialDeviation.relative==='vor dem Soll-Punkt'){
      conflicting=true;
    }
  }

  if(posAgeSec===null||posAgeSec>STALE_MAX_AGE){
    return TRUST.stale;
  }
  if(conflicting){
    return TRUST.conflicting;
  }
  if(posAgeSec<=FRESH_MAX_AGE&&feedOk){
    return TRUST.current;
  }
  if(posAgeSec<=STALE_MAX_AGE){
    return TRUST.estimated;
  }
  return TRUST.unknown;
}

function positionQuality(vehicle,nowSec,feedUpdatesOk){
  const age=feedAgeSeconds(vehicle,nowSec*1000);
  if(age===null)return TRUST.unknown;
  if(age<=FRESH_MAX_AGE&&feedUpdatesOk)return TRUST.current;
  if(age<=STALE_MAX_AGE)return TRUST.estimated;
  return TRUST.stale;
}

export function formatJourneyDelay(seconds){
  if(seconds===null||seconds===undefined)return 'Keine Prognose';
  const min=Math.round(seconds/60);
  if(min>0)return `+${min} Min.`;
  if(min<0)return `${min} Min.`;
  return '0 Min.';
}

export function journeyAvailable(vehicle,indexes){
  if(!vehicle)return false;
  const db=indexes?.[vehicle.source];
  if(!db||!dateGTFSValid(db,new Date()))return false;
  if(!vehicle.tripId)return false;
  const trip=db.trips?.[vehicle.tripId];
  return Boolean(trip&&trip[5]!==false);
}

/* Persönlicher Reiseassistent: prüft ob eine Journey ein Favorit ist (Linie, Zug/Trip oder Haltestelle).
   Nutzt dieselbe Matching-Logik wie matchesFavoriteIssue in radar58-logic.mjs. Erfindet keine Favoriten. */
export function journeyFavoriteStatus(journey,favorites){
  if(!journey||!Array.isArray(favorites))return null;
  return favorites.some(f=>{
    if(!f||!['line','train','station'].includes(f.type))return false;
    const val=String(f.value||'').trim().toLocaleLowerCase('de');
    if(!val)return false;
    if(f.type==='line')return String(journey.line).trim().toLocaleLowerCase('de')===val;
    if(f.type==='train')return String(journey.tripId).trim().toLocaleLowerCase('de')===val;
    if(f.type==='station'){
      if(journey.nextStop&&String(journey.nextStop.name).trim().toLocaleLowerCase('de')===val)return true;
      return (journey.upcoming||[]).some(s=>String(s.name).trim().toLocaleLowerCase('de')===val);
    }
    return false;
  });
}
