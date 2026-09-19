"use client";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
const key = "scout-selected-mission";
function subscribe(callback:()=>void) { window.addEventListener("storage",callback);window.addEventListener("scout-mission-change",callback);return ()=>{window.removeEventListener("storage",callback);window.removeEventListener("scout-mission-change",callback);}; }
function snapshot() {try{return localStorage.getItem(key);}catch{return null;}}
export function ScoutMissionContext({ missionId, dashboard = false }: { missionId?: string; dashboard?: boolean }) {
  const stored=useSyncExternalStore(subscribe,snapshot,()=>null);const [dismissed,setDismissed]=useState(false);
  useEffect(()=>{if(missionId&&/^[0-9a-f-]{36}$/i.test(missionId)){try{localStorage.setItem(key,missionId);window.dispatchEvent(new Event("scout-mission-change"));}catch{/* storage is optional */}}},[missionId]);
  const selected=missionId||stored;
  if(dismissed||!selected||!/^[0-9a-f-]{36}$/i.test(selected))return null;
  return <div className="scout-banner" style={{margin:"16px 0",padding:18,border:"1px solid #cbded5",borderRadius:12,background:"#eef5ef"}}><div><strong>Your selected photo mission</strong><p style={{fontSize:12}}>Keep your mission handy while you finish setup. Availability and payout may change until you claim.</p><Link className="button button-small" href={dashboard?`/dashboard/missions/${selected}`:`/missions/${selected}`}>{dashboard?"Review mission / claim":"View mission availability"}</Link> <button type="button" className="button button-small button-ghost" onClick={()=>{try{localStorage.removeItem(key);window.dispatchEvent(new Event("scout-mission-change"));}catch{}setDismissed(true);}}>Dismiss</button></div></div>;
}
