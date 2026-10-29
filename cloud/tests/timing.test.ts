import test from 'node:test';
import assert from 'node:assert/strict';
import {safeDate,safeEpoch,expectedDelivery,latestEvent,storedTiming} from '../lib/parcel/timing.ts';
test('safe dates preserve precision and reject prose, identifiers, invalid calendar and clock',()=>{
 assert.deepEqual(safeDate('2028-02-29'),{date:'2028-02-29',time:null,timezone:null});
 assert.deepEqual(safeDate('2026-10-13 14:25:00'),{date:'2026-10-13',time:'14:25',timezone:null});
 assert.deepEqual(safeDate('2026-10-13T14:25:00-04:00'),{date:'2026-10-13',time:'18:25',timezone:'UTC'});
 for(const d of ['2026-02-29','2026-02-30','2026-13-01','2026-10-13T24:00','2026-10-13T12:61','2026-10-13T12:00:61','2026-10-13T12:00+14:30','tomorrow','10/11/2026','private@example.test','2026-10-13 at 123 Main St'])assert.equal(safeDate(d),null,d);
});
test('epochs accept only disjoint plausible seconds or milliseconds; never numeric strings',()=>{
 const at=Date.UTC(2026,9,13,18,25);assert.deepEqual(safeEpoch(at),safeEpoch(at/1000));
 for(const n of [0,-1,NaN,Infinity,at/1000+.5,String(at),123456,99999999999])assert.equal(safeEpoch(n),null);
});
test('expected dates, local-clock windows and absolute windows remain explicit',()=>{
 assert.deepEqual(expectedDelivery({date_expected:'2026-10-13'}),{date:'2026-10-13',time:null,timezone:null,end_date:null,end_time:null,source:'parcel_api'});
 assert.equal(expectedDelivery({date_expected:'2026-10-13 00:00:00'})?.time,null);
 assert.equal(storedTiming(JSON.stringify({date:'2026-10-13',time:'00:00',timezone:null,end_date:null,end_time:null,source:'parcel_api'}),'expected')?.time,null);
 assert.equal(expectedDelivery({date_expected:'2026-10-13 00:00:00',date_expected_end:'2026-10-13 03:00:00'})?.time,'00:00');
 assert.deepEqual(expectedDelivery({date_expected:'2026-10-13 12:00',date_expected_end:'2026-10-13 16:00'}),{date:'2026-10-13',time:'12:00',timezone:null,end_date:'2026-10-13',end_time:'16:00',source:'parcel_api'});
 assert.equal(expectedDelivery({date_expected:'2026-10-14',date_expected_end:'2026-10-13'}),null);
 assert.equal(expectedDelivery({date_expected:'2026-10-13',date_expected_end:'private@example.test'}),null);
 assert.equal(expectedDelivery({date_expected:'2026-10-13T12:00Z',date_expected_end:'2026-10-13 16:00'}),null);
 assert.equal(expectedDelivery({date_expected:'2026-10-13T12:00:59Z',date_expected_end:'2026-10-13T12:00:00Z'}),null);
 const at=Date.UTC(2026,9,13,12);assert.deepEqual(expectedDelivery({timestamp_expected:at/1000,timestamp_expected_end:at/1000+3600}),{date:'2026-10-13',time:'12:00',timezone:'UTC',end_date:'2026-10-13',end_time:'13:00',source:'parcel_api'});
});
test('latest event comes from actual dated event, not ordering, status code or raw text',()=>{
 const events=[{event:'Arrived at USPS Regional Facility, 123 Private St',date:'2026-10-12 13:00',location:'Private address',additional:'private@example.test'},{event:'Shipping Label Created, Jane Name',date:'2026-10-11 10:00'}];
 assert.deepEqual(latestEvent(events),{date:'2026-10-12',time:'13:00',timezone:null,status:'arrived_at_facility',source:'parcel_api'});
 assert.deepEqual(latestEvent([...events].reverse()),latestEvent(events));
 assert.ok(!JSON.stringify(latestEvent(events)).includes('Private'));
 assert.equal(latestEvent([{event:'Delivered',date:'2026-10-13'},{event:'In transit',date:'2026-10-13 09:00'}]),null);
 assert.equal(latestEvent([{event:'Out for delivery cancelled',date:'2026-10-13 09:00'}]),null);
 assert.equal(latestEvent([{event:'Delivered status has been cancelled',date:'2026-10-13 09:00'}]),null);
 assert.equal(latestEvent([{event:'Delivered',date:'2026-10-12 09:00'},{event:'In transit',date:'2026-10-12 09:00'},{event:'Out for delivery',date:'2026-10-13 09:00'}])?.status,'out_for_delivery');
 for(const value of [[],null,{},[{event:'Not delivered',date:'2026-10-13'}],[{event:'Out for delivery',date:'tomorrow'}],[...events,{event:'A private unrecognized event',date:'2026-10-14'}],[...events,{event:'Delivered',date:'2026-10-14T12:00Z'}],[...events,{event:'Delivered',date:'2026-10-12 13:00'}]])assert.equal(latestEvent(value),null);
});
test('stored timing revalidation rejects corruption, extra fields and arbitrary event status',()=>{
 const expected=expectedDelivery({date_expected:'2026-10-13'});assert.deepEqual(storedTiming(JSON.stringify(expected),'expected'),expected);
 for(const change of [{tracking_number:'private'}, {date:'2026-02-30'}, {time:'not a time'}, {timezone:'Private'}, {end_date:'2026-01-01'}])assert.equal(storedTiming(JSON.stringify({...expected,...change}),'expected'),null);
 const event=latestEvent([{event:'Delivered',date:'2026-10-13'}]);assert.deepEqual(storedTiming(JSON.stringify(event),'event'),event);assert.equal(storedTiming(JSON.stringify({...event,status:'Private text'}),'event'),null);
});
