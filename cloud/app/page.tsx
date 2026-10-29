'use client';
import {useEffect,useState} from 'react';
import {ImporterView} from './status-view';
import type {Status} from './status-view';
export default function Home(){const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
async function refresh(){setLoading(true);setError('');try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw new Error(r.status===401?'Sign in to view your importer.':r.status===403?'This importer is private to its owner.':'Status is temporarily unavailable.');setStatus(await r.json())}catch(e){setError(e instanceof Error?e.message:'Status is temporarily unavailable.')}finally{setLoading(false)}}
useEffect(()=>{void refresh()},[]);
return <ImporterView status={status} error={error} loading={loading} refresh={refresh}/>;}
