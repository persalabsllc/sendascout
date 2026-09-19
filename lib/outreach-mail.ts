import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { normalizeEmail, OUTREACH_ORIGIN } from "./outreach-content.ts";
export function encryptOutreachToken(token:string,keyHex:string) {
  if(!/^[a-f0-9]{64}$/i.test(keyHex))throw new Error("Outreach encryption key is not configured.");
  const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",Buffer.from(keyHex,"hex"),iv);
  cipher.setAAD(Buffer.from("sendascout-gmail-v1"));
  const encrypted=Buffer.concat([cipher.update(token,"utf8"),cipher.final()]);
  return ["v1",iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),encrypted.toString("base64url")].join(".");
}
export function decryptOutreachToken(value:string,keyHex:string) {
  if(!/^[a-f0-9]{64}$/i.test(keyHex))throw new Error("Outreach encryption key is not configured.");
  const [version,iv,tag,encrypted]=value.split(".");if(version!=="v1"||!iv||!tag||!encrypted)throw new Error("Invalid mailbox connection.");
  const cipher=createDecipheriv("aes-256-gcm",Buffer.from(keyHex,"hex"),Buffer.from(iv,"base64url"));
  cipher.setAAD(Buffer.from("sendascout-gmail-v1"));cipher.setAuthTag(Buffer.from(tag,"base64url"));
  return Buffer.concat([cipher.update(Buffer.from(encrypted,"base64url")),cipher.final()]).toString("utf8");
}
export function outreachRawEmail(input:{from:string;to:string;subject:string;body:string;id:string;unsubscribeToken:string;postalAddress:string;inReplyTo?:string}) {
  const from=normalizeEmail(input.from),to=normalizeEmail(input.to);
  if(/[\r\n]/.test(input.subject)||!input.subject.trim()||input.subject.length>200)throw new Error("Enter a subject of 1–200 characters without line breaks.");
  if(!/^[a-z0-9-]+@sendascout\.com$/.test(input.id)||!/^[a-f0-9]{64}$/.test(input.unsubscribeToken))throw new Error("Invalid message identity.");
  if(input.inReplyTo&&!/^[a-z0-9-]+@sendascout\.com$/.test(input.inReplyTo))throw new Error("Invalid reply identity.");
  if(input.postalAddress.trim().length<10)throw new Error("Save your business postal address before sending.");
  const unsubscribe=`${OUTREACH_ORIGIN}/outreach/unsubscribe/${input.unsubscribeToken}`;
  const body=`${input.body.trim()}\n\n—\nBusiness introduction from Send a Scout LLC\n${input.postalAddress.trim()}\nUnsubscribe from outreach: ${unsubscribe}`;
  const raw=[`From: Send a Scout <${from}>`,`To: ${to}`,`Reply-To: ${from}`,`Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`,`Message-ID: <${input.id}>`,...(input.inReplyTo?[`In-Reply-To: <${input.inReplyTo}>`,`References: <${input.inReplyTo}>`]:[]),`Date: ${new Date().toUTCString()}`,`List-Unsubscribe: <${unsubscribe}>`,`List-Unsubscribe-Post: List-Unsubscribe=One-Click`,"MIME-Version: 1.0","Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: base64","",Buffer.from(body).toString("base64").match(/.{1,76}/g)!.join("\r\n")].join("\r\n");
  return Buffer.from(raw).toString("base64url");
}
