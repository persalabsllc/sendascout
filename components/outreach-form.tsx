"use client";
import { useActionState, type ReactNode } from "react";
import Link from "next/link";
import type { OutreachActionState } from "@/app/actions/outreach";
export function OutreachForm({action,children,label,disabled=false,className=""}:{action:(state:OutreachActionState,data:FormData)=>Promise<OutreachActionState>;children?:ReactNode;label:string;disabled?:boolean;className?:string}) {
  const [state,submit,pending]=useActionState(action,{});
  return <form action={submit} className={className}><fieldset disabled={pending||disabled} style={{border:0,padding:0,margin:0,minWidth:0}}>{children}<button type="submit" className="button button-small" disabled={pending||disabled}>{pending?"Working…":label}</button></fieldset>{state.message&&<p role="status" style={{color:state.ok?"#155b4a":"#a0352d",lineHeight:1.5}}>{state.message}{state.href&&<> <Link href={state.href}>Open prospect →</Link></>}</p>}</form>;
}
